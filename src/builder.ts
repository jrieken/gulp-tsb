'use strict';

import { Stats, statSync, readFileSync, existsSync } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as utils from './utils';
import { EOL } from "os";
import * as log from 'fancy-log';
import * as colors from 'ansi-colors';
import * as ts from 'typescript';
import Vinyl = require('vinyl');

export interface IConfiguration {
    json: boolean;
    noFilesystemLookup: boolean;
    verbose: boolean;
    _emitWithoutBasePath?: boolean;
    _emitLanguageService?: boolean;
}

export interface CancellationToken {
    isCancellationRequested(): boolean;
}

export namespace CancellationToken {
    export const None: CancellationToken = {
        isCancellationRequested() { return false }
    };
}

export interface ITypeScriptBuilder {
    build(out: (file: Vinyl) => void, onError: (err: any) => void, token?: CancellationToken): Promise<any>;
    file(file: Vinyl): void;
    languageService: ts.LanguageService;
}

function normalize(path: string): string {
    return path.replace(/\\/g, '/');
}

export function createTypeScriptBuilder(config: IConfiguration, compilerOptions: ts.CompilerOptions): ITypeScriptBuilder {

    let host = new LanguageServiceHost(compilerOptions, config.noFilesystemLookup || false),
        service = ts.createLanguageService(host, ts.createDocumentRegistry()),
        lastBuildVersion: { [path: string]: string } = Object.create(null),
        lastDtsHash: { [path: string]: string } = Object.create(null),
        userWantsDeclarations = compilerOptions.declaration,
        oldErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null),
        headUsed = process.memoryUsage().heapUsed,
        emitSourceMapsInStream = true;

    // always emit declaraction files
    host.getCompilationSettings().declaration = true;

    function _log(topic: string, message: string): void {
        if (config.verbose) {
            log(colors.cyan(topic), message);
        }
    }

    function printDiagnostic(diag: ts.Diagnostic, onError: (err: any) => void): void {

        var lineAndCh = diag.file.getLineAndCharacterOfPosition(diag.start),
            message: string;

        if (!config.json) {
            message = utils.strings.format('{0}({1},{2}): {3}',
                diag.file.fileName,
                lineAndCh.line + 1,
                lineAndCh.character + 1,
                ts.flattenDiagnosticMessageText(diag.messageText, '\n'));

        } else {
            message = JSON.stringify({
                filename: diag.file.fileName,
                offset: diag.start,
                length: diag.length,
                message: ts.flattenDiagnosticMessageText(diag.messageText, '\n')
            });
        }

        onError(message);
    }

    function file(file: Vinyl): void {
        // support gulp-sourcemaps
        if ((<any>file).sourceMap) {
            emitSourceMapsInStream = false;
        }

        if (!file.contents) {
            host.removeScriptSnapshot(file.path);
        } else {
            host.addScriptSnapshot(file.path, new VinylScriptSnapshot(file));
        }
    }

    function baseFor(snapshot: ScriptSnapshot): string {
        if (snapshot instanceof VinylScriptSnapshot) {
            return compilerOptions.outDir || snapshot.getBase();
        } else {
            return '';
        }
    }

    function isExternalModule(sourceFile: ts.SourceFile): boolean {
        return (<any>sourceFile).externalModuleIndicator
            || /declare\s+module\s+('|")(.+)\1/.test(sourceFile.getText())
    }

    function build(out: (file: Vinyl) => void, onError: (err: any) => void, token = CancellationToken.None): Promise<any> {

        function checkSyntaxSoon(fileName: string): Promise<ts.Diagnostic[]> {
            return new Promise<ts.Diagnostic[]>(resolve => {
                process.nextTick(function () {
                    resolve(service.getSyntacticDiagnostics(fileName));
                });
            });
        }

        function checkSemanticsSoon(fileName: string): Promise<ts.Diagnostic[]> {
            return new Promise<ts.Diagnostic[]>(resolve => {
                process.nextTick(function () {
                    resolve(service.getSemanticDiagnostics(fileName));
                });
            });
        }

        function emitSoon(fileName: string): Promise<{ fileName: string, signature: string, files: Vinyl[] }> {

            return new Promise(resolve => {
                process.nextTick(function () {

                    if (/\.d\.ts$/.test(fileName)) {
                        // if it's already a d.ts file just emit it signature
                        let snapshot = host.getScriptSnapshot(fileName);
                        let signature = crypto.createHash('md5')
                            .update(snapshot.getText(0, snapshot.getLength()))
                            .digest('base64');

                        return resolve({
                            fileName,
                            signature,
                            files: []
                        });
                    }

                    let output = service.getEmitOutput(fileName);
                    let files: Vinyl[] = [];
                    let signature: string;

                    for (let file of output.outputFiles) {
                        if (!emitSourceMapsInStream && /\.js\.map$/.test(file.name)) {
                            continue;
                        }

                        if (/\.d\.ts$/.test(file.name)) {
                            signature = crypto.createHash('md5')
                                .update(file.text)
                                .digest('base64');

                            if (!userWantsDeclarations) {
                                // don't leak .d.ts files if users don't want them
                                continue;
                            }
                        }

                        let vinyl = new Vinyl({
                            path: file.name,
                            contents: new Buffer(file.text),
                            base: !config._emitWithoutBasePath && baseFor(host.getScriptSnapshot(fileName))
                        });

                        if (!emitSourceMapsInStream && /\.js$/.test(file.name)) {
                            let sourcemapFile = output.outputFiles.filter(f => /\.js\.map$/.test(f.name))[0];

                            if (sourcemapFile) {
                                let extname = path.extname(vinyl.relative);
                                let basename = path.basename(vinyl.relative, extname);
                                let dirname = path.dirname(vinyl.relative);
                                let tsname = (dirname === '.' ? '' : dirname + '/') + basename + '.ts';

                                let sourceMap = JSON.parse(sourcemapFile.text);
                                sourceMap.sources[0] = tsname.replace(/\\/g, '/');
                                (<any>vinyl).sourceMap = sourceMap;
                            }
                        }

                        files.push(vinyl);
                    }

                    resolve({
                        fileName,
                        signature,
                        files
                    });
                });
            });
        }

        let newErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null);
        let t1 = Date.now();

        let toBeEmitted: string[] = [];
        let toBeCheckedSyntactically: string[] = [];
        let toBeCheckedSemantically: string[] = [];
        let filesWithChangedSignature: string[] = [];
        let dependentFiles: string[] = [];
        let newLastBuildVersion = new Map<string, string>();

        for (let fileName of host.getScriptFileNames()) {
            if (lastBuildVersion[fileName] !== host.getScriptVersion(fileName)) {

                toBeEmitted.push(fileName);
                toBeCheckedSyntactically.push(fileName);
                toBeCheckedSemantically.push(fileName);
            }
        }

        return new Promise(resolve => {

            let semanticCheckInfo = new Map<string, number>();
            let seenAsDependentFile = new Set<string>();

            function workOnNext() {

                let promise: Promise<any>;
                let fileName: string;

                // someone told us to stop this
                if (token.isCancellationRequested()) {
                    _log('[CANCEL]', '>>This compile run was cancelled<<')
                    newLastBuildVersion.clear();
                    resolve();
                    return;
                }

                // (1st) emit code
                else if (toBeEmitted.length) {
                    fileName = toBeEmitted.pop();
                    promise = emitSoon(fileName).then(value => {

                        for (let file of value.files) {
                            _log('[emit code]', file.path);
                            out(file);
                        }

                        // remember when this was build
                        newLastBuildVersion.set(fileName, host.getScriptVersion(fileName));

                        // remeber the signature
                        if (value.signature && lastDtsHash[fileName] !== value.signature) {
                            lastDtsHash[fileName] = value.signature;
                            filesWithChangedSignature.push(fileName);
                        }
                    });
                }

                // (2nd) check syntax
                else if (toBeCheckedSyntactically.length) {
                    fileName = toBeCheckedSyntactically.pop();
                    _log('[check syntax]', fileName);
                    promise = checkSyntaxSoon(fileName).then(diagnostics => {
                        delete oldErrors[fileName];
                        if (diagnostics.length > 0) {
                            diagnostics.forEach(d => printDiagnostic(d, onError));
                            newErrors[fileName] = diagnostics;

                            // stop the world when there are syntax errors
                            toBeCheckedSyntactically.length = 0;
                            toBeCheckedSemantically.length = 0;
                            filesWithChangedSignature.length = 0;
                        }
                    });
                }

                // (3rd) check semantics
                else if (toBeCheckedSemantically.length) {

                    fileName = toBeCheckedSemantically.pop();
                    while (fileName && semanticCheckInfo.has(fileName)) {
                        fileName = toBeCheckedSemantically.pop();
                    }

                    if (fileName) {
                        _log('[check semantics]', fileName);
                        promise = checkSemanticsSoon(fileName).then(diagnostics => {
                            delete oldErrors[fileName];
                            semanticCheckInfo.set(fileName, diagnostics.length);
                            if (diagnostics.length > 0) {
                                diagnostics.forEach(d => printDiagnostic(d, onError));
                                newErrors[fileName] = diagnostics;
                            }
                        });
                    }
                }

                // (4th) check dependents
                else if (filesWithChangedSignature.length) {
                    while (filesWithChangedSignature.length) {
                        let fileName = filesWithChangedSignature.pop();

                        if (!isExternalModule(service.getProgram().getSourceFile(fileName))) {
                            _log('[check semantics*]', fileName + ' is an internal module and it has changed shape -> check whatever hasn\'t been checked yet');
                            toBeCheckedSemantically.push(...host.getScriptFileNames());
                            filesWithChangedSignature.length = 0;
                            dependentFiles.length = 0;
                            break;
                        }

                        host.collectDependents(fileName, dependentFiles);
                    }
                }

                // (5th) dependents contd
                else if (dependentFiles.length) {
                    fileName = dependentFiles.pop();
                    while (fileName && seenAsDependentFile.has(fileName)) {
                        fileName = dependentFiles.pop();
                    }
                    if (fileName) {
                        seenAsDependentFile.add(fileName);
                        let value = semanticCheckInfo.get(fileName);
                        if (value === 0) {
                            // already validated successfully -> look at dependents next
                            host.collectDependents(fileName, dependentFiles);

                        } else if (typeof value === 'undefined') {
                            // first validate -> look at dependents next
                            dependentFiles.push(fileName);
                            toBeCheckedSemantically.push(fileName);
                        }
                    }
                }

                // (last) done
                else {
                    resolve();
                    return;
                }

                if (!promise) {
                    promise = Promise.resolve();
                }

                promise.then(function () {
                    // change to change
                    process.nextTick(workOnNext);
                }).catch(err => {
                    console.error(err);
                });
            }

            workOnNext();

        }).then(() => {
            // store the build versions to not rebuilt the next time
            newLastBuildVersion.forEach((value, key) => {
                lastBuildVersion[key] = value;
            });

            // print old errors and keep them
            utils.collections.forEach(oldErrors, entry => {
                entry.value.forEach(diag => printDiagnostic(diag, onError));
                newErrors[entry.key] = entry.value;
            });
            oldErrors = newErrors;

            // print stats
            if (config.verbose) {
                var headNow = process.memoryUsage().heapUsed,
                    MB = 1024 * 1024;
                log('[tsb]',
                    'time:', colors.yellow((Date.now() - t1) + 'ms'),
                    'mem:', colors.cyan(Math.ceil(headNow / MB) + 'MB'), colors.bgcyan('Δ' + Math.ceil((headNow - headUsed) / MB)));
                headUsed = headNow;
            }
        });
    }

    return {
        file,
        build,
        languageService: service
    };
}

class ScriptSnapshot implements ts.IScriptSnapshot {

    private _text: string;
    private _mtime: Date;

    constructor(text: string, mtime: Date) {
        this._text = text;
        this._mtime = mtime;
    }

    public getVersion(): string {
        return this._mtime.toUTCString();
    }

    public getText(start: number, end: number): string {
        return this._text.substring(start, end);
    }

    public getLength(): number {
        return this._text.length;
    }

    public getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange {
        return null;
    }
}

class VinylScriptSnapshot extends ScriptSnapshot {

    private _base: string;

    constructor(file: Vinyl) {
        super(file.contents.toString(), file.stat.mtime);
        this._base = file.base;
    }

    public getBase(): string {
        return this._base;
    }
}

class LanguageServiceHost implements ts.LanguageServiceHost {

    private _settings: ts.CompilerOptions;
    private _noFilesystemLookup: boolean;
    private _snapshots: { [path: string]: ScriptSnapshot };
    private _projectVersion: number;
    private _dependencies: utils.graph.Graph<string>;
    private _dependenciesRecomputeList: string[];
    private _fileNameToDeclaredModule: { [path: string]: string[] };

    constructor(settings: ts.CompilerOptions, noFilesystemLookup: boolean) {
        this._settings = settings;
        this._noFilesystemLookup = noFilesystemLookup;
        this._snapshots = Object.create(null);
        this._projectVersion = 1;
        this._dependencies = new utils.graph.Graph<string>(s => s);
        this._dependenciesRecomputeList = [];
        this._fileNameToDeclaredModule = Object.create(null);
    }

    log(s: string): void {
        // nothing
    }

    trace(s: string): void {
        // nothing
    }

    error(s: string): void {
        console.error(s);
    }

    getCompilationSettings(): ts.CompilerOptions {
        return this._settings;
    }

    getProjectVersion(): string {
        return String(this._projectVersion);
    }

    getScriptFileNames(): string[] {
        const result: string[] = [];
        const libLocation = this.getDefaultLibLocation();
        for (let fileName in this._snapshots) {
            if (/\.tsx?/i.test(path.extname(fileName))
                && normalize(path.dirname(fileName)) !== libLocation) {
                // only ts-files and not lib.d.ts-like files
                result.push(fileName)
            }
        }
        return result;
    }

    getScriptVersion(filename: string): string {
        filename = normalize(filename);
        return this._snapshots[filename].getVersion();
    }

    getScriptSnapshot(filename: string): ScriptSnapshot {
        filename = normalize(filename);
        let result = this._snapshots[filename];
        if (!result && !this._noFilesystemLookup) {
            try {
                result = new VinylScriptSnapshot(new Vinyl(<any>{
                    path: filename,
                    contents: readFileSync(filename),
                    base: this._settings.outDir,
                    stat: statSync(filename)
                }));
                this.addScriptSnapshot(filename, result);
            } catch (e) {
                // ignore
            }
        }
        return result;
    }

    private static _declareModule = /declare\s+module\s+('|")(.+)\1/g;

    addScriptSnapshot(filename: string, snapshot: ScriptSnapshot): ScriptSnapshot {
        this._projectVersion++;
        filename = normalize(filename);
        var old = this._snapshots[filename];
        if (!old || old.getVersion() !== snapshot.getVersion()) {
            this._dependenciesRecomputeList.push(filename);
            var node = this._dependencies.lookup(filename);
            if (node) {
                node.outgoing = Object.create(null);
            }

            // (cheap) check for declare module
            LanguageServiceHost._declareModule.lastIndex = 0;
            let match: RegExpExecArray;
            while ((match = LanguageServiceHost._declareModule.exec(snapshot.getText(0, snapshot.getLength())))) {
                let declaredModules = this._fileNameToDeclaredModule[filename];
                if (!declaredModules) {
                    this._fileNameToDeclaredModule[filename] = declaredModules = [];
                }
                declaredModules.push(match[2]);
            }
        }
        this._snapshots[filename] = snapshot;
        return old;
    }

    removeScriptSnapshot(filename: string): boolean {
        this._projectVersion++;
        filename = normalize(filename);
        delete this._fileNameToDeclaredModule[filename];
        return delete this._snapshots[filename];
    }

    getLocalizedDiagnosticMessages(): any {
        return null;
    }

    getCancellationToken(): ts.CancellationToken {
        return {
            isCancellationRequested: () => false,
            throwIfCancellationRequested: (): void => {
                // Do nothing.isCancellationRequested is always
                // false so this method never throws
            }
        };
    }

    getCurrentDirectory(): string {
        return process.cwd();
    }

    fileExists(fileName: string): boolean {
        return !this._noFilesystemLookup && existsSync(fileName);
    }

    readFile(fileName: string): string {
        return this._noFilesystemLookup ? '' : readFileSync(fileName, 'utf8');
    }

    getDefaultLibFileName(options: ts.CompilerOptions): string {
        return normalize(path.join(this.getDefaultLibLocation(), ts.getDefaultLibFileName(options)));
    }

    getDefaultLibLocation() {
        let typescriptInstall = require.resolve('typescript');
        return normalize(path.dirname(typescriptInstall));
    }

    // ---- dependency management

    collectDependents(filename: string, target: string[]): void {
        while (this._dependenciesRecomputeList.length) {
            this._processFile(this._dependenciesRecomputeList.pop());
        }
        filename = normalize(filename);
        var node = this._dependencies.lookup(filename);
        if (node) {
            utils.collections.forEach(node.incoming, entry => target.push(entry.key));
        }
    }

    _processFile(filename: string): void {
        if (filename.match(/.*\.d\.ts$/)) {
            return;
        }
        filename = normalize(filename);
        var snapshot = this.getScriptSnapshot(filename),
            info = ts.preProcessFile(snapshot.getText(0, snapshot.getLength()), true);

        // (1) ///-references
        info.referencedFiles.forEach(ref => {
            var resolvedPath = path.resolve(path.dirname(filename), ref.fileName),
                normalizedPath = normalize(resolvedPath);

            this._dependencies.inertEdge(filename, normalizedPath);
        });

        // (2) import-require statements
        info.importedFiles.forEach(ref => {
            var stopDirname = normalize(this.getCurrentDirectory()),
                dirname = filename,
                found = false;

            while (!found && dirname.indexOf(stopDirname) === 0) {
                dirname = path.dirname(dirname);
                var resolvedPath = path.resolve(dirname, ref.fileName),
                    normalizedPath = normalize(resolvedPath);

                if (this.getScriptSnapshot(normalizedPath + '.ts')) {
                    this._dependencies.inertEdge(filename, normalizedPath + '.ts');
                    found = true;

                } else if (this.getScriptSnapshot(normalizedPath + '.d.ts')) {
                    this._dependencies.inertEdge(filename, normalizedPath + '.d.ts');
                    found = true;
                }
            }

            if (!found) {
                for (let key in this._fileNameToDeclaredModule) {
                    if (this._fileNameToDeclaredModule[key] && ~this._fileNameToDeclaredModule[key].indexOf(ref.fileName)) {
                        this._dependencies.inertEdge(filename, key);
                    }
                }
            }
        });
    }
}
