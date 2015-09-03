'use strict';

import {Stats, statSync, readFileSync} from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as utils from './utils';
import {log, colors} from 'gulp-util';
import * as ts from './typescript/typescriptServices';
import Vinyl = require('vinyl');

export interface IConfiguration {
    json: boolean;
    verbose: boolean;
    _emitWithoutBasePath?: boolean;
    _emitLanguageService?: boolean;
    [option: string]: string | number | boolean;
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
}

function normalize(path: string): string {
    return path.replace(/\\/g, '/');
}

export function createTypeScriptBuilder(config: IConfiguration): ITypeScriptBuilder {

    var compilerOptions = createCompilerOptions(config),
        host = new LanguageServiceHost(compilerOptions),
        service = ts.createLanguageService(host, ts.createDocumentRegistry()),
        lastBuildVersion: { [path: string]: string } = Object.create(null),
        lastDtsHash: { [path: string]: string } = Object.create(null),
        userWantsDeclarations = compilerOptions.declaration,
        oldErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null),
        headUsed = process.memoryUsage().heapUsed;

    // always emit declaraction files
    host.getCompilationSettings().declaration = true;

    if (!host.getCompilationSettings().noLib) {
        var defaultLib = host.getDefaultLibFileName();
        host.addScriptSnapshot(defaultLib, new DefaultLibScriptSnapshot(defaultLib));
    }

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
        return !!(<any> sourceFile).externalModuleIndicator;
    }

    function build(out: (file: Vinyl) => void, onError: (err: any) => void, token = CancellationToken.None): Promise<any> {

        function checkSyntaxSoon(fileName: string): Promise<ts.Diagnostic[]> {
            return new Promise<ts.Diagnostic[]>(resolve => {
                  setTimeout(function () {
                      resolve(service.getSyntacticDiagnostics(fileName));
                }, 0);
            });
        }

        function checkSemanticsSoon(fileName: string): Promise<ts.Diagnostic[]> {
            return new Promise<ts.Diagnostic[]>(resolve => {
                  setTimeout(function () {
                      resolve(service.getSemanticDiagnostics(fileName));
                }, 0);
            });
        }

        function emitSoon(fileName: string): Promise<{ fileName:string, signature: string, files: Vinyl[] }> {

            return new Promise(resolve => {
                setTimeout(function () {
                    let output = service.getEmitOutput(fileName);
                    let files: Vinyl[] = [];
                    let signature: string;

                    for (let file of output.outputFiles) {
                        if (/\.d\.ts$/.test(file.name)) {
                            signature = crypto.createHash('md5')
                                .update(file.text)
                                .digest('base64');

                            if (!userWantsDeclarations) {
                                // don't leak .d.ts files if users don't want them
                                continue;
                            }
                        }
                        files.push(new Vinyl({
                            path: file.name,
                            contents: new Buffer(file.text),
                            base: !config._emitWithoutBasePath && baseFor(host.getScriptSnapshot(fileName))
                        }));
                    }

                    resolve({
                        fileName,
                        signature,
                        files
                    });
                }, 0);
            });
        }

        let newErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null);
        let t1 = Date.now();

        let toBeEmitted: string[] = [];
        let toBeCheckedSyntactically: string[] = [];
        let toBeCheckedSemantically: string[] = [];
        let filesWithChangedSignature: string[] = [];
        let dependentFiles: string[] = [];

        for (let fileName of host.getScriptFileNames()) {
            if (lastBuildVersion[fileName] !== host.getScriptVersion(fileName)) {
                toBeEmitted.push(fileName);
                toBeCheckedSyntactically.push(fileName);
                toBeCheckedSemantically.push(fileName);
            }
        }

        return new Promise(resolve => {

            let semanticCheckInfo = new Map<string, number>();

            function workOnNext() {

                let promise: Promise<any>;
                let fileName: string;

                // someone told us to stop this
                if (token.isCancellationRequested()) {
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

                        // remeber when this was build
                        lastBuildVersion[fileName] = host.getScriptVersion(fileName);

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

                        if (true || !isExternalModule(service.getSourceFile(fileName))) {
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
                    setTimeout(workOnNext, 0);
                }).catch(err => {
                    console.error(err);
                });
            }

            workOnNext();

        }).then(() => {
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
                    'mem:', colors.cyan(Math.ceil(headNow / MB) + 'MB'), colors.bgCyan('Δ' + Math.ceil((headNow - headUsed) / MB)));
                headUsed = headNow;
            }
        });
    }

    return {
        file,
        build
    };
}

function createCompilerOptions(config: IConfiguration): ts.CompilerOptions {

    // language version
    if (!config['target']) {
        config['target'] = ts.ScriptTarget.ES3;
    } else if (/ES3/i.test(String(config['target']))) {
        config['target'] = ts.ScriptTarget.ES3;
    } else if (/ES5/i.test(String(config['target']))) {
        config['target'] = ts.ScriptTarget.ES5;
    } else if (/ES6/i.test(String(config['target']))) {
        config['target'] = ts.ScriptTarget.ES6;
    }

    // module generation
    if (/commonjs/i.test(String(config['module']))) {
        config['module'] = ts.ModuleKind.CommonJS;
    } else if (/amd/i.test(String(config['module']))) {
        config['module'] = ts.ModuleKind.AMD;
    }

    return <ts.CompilerOptions> config;
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

class DefaultLibScriptSnapshot extends ScriptSnapshot {

    constructor(defaultLib: string) {
        super(readFileSync(defaultLib).toString(), statSync(defaultLib).mtime);
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
    private _snapshots: { [path: string]: ScriptSnapshot };
    private _defaultLib: string;
    private _dependencies: utils.graph.Graph<string>;
    private _dependenciesRecomputeList: string[];

    constructor(settings: ts.CompilerOptions) {
        this._settings = settings;
        this._snapshots = Object.create(null);
        this._defaultLib = normalize(path.join(__dirname, 'typescript', settings.target === ts.ScriptTarget.ES6
            ? 'lib.es6.d.ts'
            : 'lib.d.ts'));
        this._dependencies = new utils.graph.Graph<string>(s => s);
        this._dependenciesRecomputeList = [];
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

    getScriptFileNames(): string[] {
        return Object.keys(this._snapshots);
    }

    getScriptVersion(filename: string): string {
        filename = normalize(filename);
        return this._snapshots[filename].getVersion();
    }

    getScriptSnapshot(filename: string): ScriptSnapshot {
        filename = normalize(filename);
        return this._snapshots[filename];
    }

    addScriptSnapshot(filename: string, snapshot: ScriptSnapshot): ScriptSnapshot {
        filename = normalize(filename);
        var old = this._snapshots[filename];
        if (!old || old.getVersion() !== snapshot.getVersion()) {
            this._dependenciesRecomputeList.push(filename);
            var node = this._dependencies.lookup(filename);
            if (node) {
                node.outgoing = Object.create(null);
            }
        }
        this._snapshots[filename] = snapshot;
        return old;
    }

    removeScriptSnapshot(filename: string): boolean {
        filename = normalize(filename);
        return delete this._snapshots[filename];
    }

    getLocalizedDiagnosticMessages(): any {
        return null;
    }

    getCancellationToken(): ts.CancellationToken {
        return { isCancellationRequested: () => false };
    }

    getCurrentDirectory(): string {
        return process.cwd();
    }

    getDefaultLibFileName(): string {
        return this._defaultLib;
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
        });
    }
}