/// <reference types="node" />

'use strict';

import Vinyl = require('vinyl');
import * as path from 'path';
import * as crypto from 'crypto';
import * as utils from './utils';
import * as ts from 'typescript';
import {EOL} from 'os';
import {log, colors} from 'gulp-util';
import {statSync, readFileSync} from 'fs';
import structuredClone = utils.collections.structuredClone;
const PromisePolyfill: typeof Promise = require('pinkie-promise');

type VinylFile = Vinyl & { sourceMap?: any; };

export interface IConfiguration {
    /** Indicates whether to report compiler diagnostics as JSON instead of as a string. */
    json: boolean;
    /** Indicates whether to avoid filesystem lookups for non-root files. */
    noFilesystemLookup: boolean;
    /** Indicates whether to report verbose compilation messages. */
    verbose: boolean;
    /** Provides an explicit instance of the typescript compiler to use. */
    typescript?: typeof ts;
    /** Indicates the base path from which a project was loaded or compilation was started. */
    base?: string;
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
}

function normalize(path: string): string {
    return path.replace(/\\/g, '/');
}

export function getTypeScript(config: IConfiguration) {
    return config.typescript || ts;
}

export function createTypeScriptBuilder(config: IConfiguration, compilerOptions: ts.CompilerOptions): ITypeScriptBuilder {
    // TODO(rbuckton): support url sourceRoot
    // TODO(rbuckton): support url mapRoot
    // TODO(rbuckton): support mapRoot
    const ts = getTypeScript(config);
    const originalCompilerOptions = structuredClone(compilerOptions);
    compilerOptions = structuredClone(compilerOptions);
    const outFile = compilerOptions.outFile || compilerOptions.out;

    if (outFile) {
        // always treat out file as relative to the root of the sources.
        compilerOptions.outFile = path.resolve(config.base, path.basename(outFile));
    }

    // clean up compiler options that conflict with gulp
    if (compilerOptions.inlineSourceMap) compilerOptions.sourceMap = true;
    delete compilerOptions.inlineSourceMap; // handled by gulp-sourcemaps or explicitly.
    delete compilerOptions.inlineSources; // handled by gulp-sourcemaps or explicitly.
    delete compilerOptions.sourceRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.mapRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.outDir; // always emit relative to source file
    delete compilerOptions.out; // outFile is preferred, see above
    compilerOptions.declaration = true; // always emit declaraction files

    let host = new LanguageServiceHost(compilerOptions, config, config.noFilesystemLookup || false, ts),
        service = ts.createLanguageService(host, ts.createDocumentRegistry()),
        lastBuildVersion: { [path: string]: string } = Object.create(null),
        lastDtsHash: { [path: string]: string } = Object.create(null),
        oldErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null),
        headUsed = process.memoryUsage().heapUsed,
        emitSourceMapsInStream = true,
        emitToSingleFile = !!compilerOptions.outFile;

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
        if ((<any>file).sourceMap && emitSourceMapsInStream) {
            emitSourceMapsInStream = false;
        }

        if (!file.contents) {
            host.removeScriptSnapshot(file.path);
        } else {
            host.addScriptSnapshot(file.path, new ScriptSnapshot(file), /*isRoot*/ true);
        }
    }

    function isExternalModule(sourceFile: ts.SourceFile): boolean {
        return (<any>sourceFile).externalModuleIndicator
            || /declare\s+module\s+('|")(.+)\1/.test(sourceFile.getText())
    }

    function getVinyl(fileName: string, base?: string) {
        if (base) fileName = path.resolve(base, fileName);
        const snapshot = host.getScriptSnapshot(fileName);
        if (snapshot instanceof ScriptSnapshot) {
            return snapshot.getFile();
        }
    }

    function getNewLine() {
        switch (compilerOptions.newLine) {
            case ts.NewLineKind.CarriageReturnLineFeed: return "\r\n";
            case ts.NewLineKind.LineFeed: return "\n";
            default: return EOL;
        }
    }

    function build(out: (file: Vinyl) => void, onError: (err: any) => void, token = CancellationToken.None): Promise<any> {

        function checkSyntaxSoon(fileName: string): Promise<ts.Diagnostic[]> {
            return new PromisePolyfill<ts.Diagnostic[]>(resolve => {
                process.nextTick(function () {
                    resolve(service.getSyntacticDiagnostics(fileName));
                });
            });
        }

        function checkSemanticsSoon(fileName: string): Promise<ts.Diagnostic[]> {
            return new PromisePolyfill<ts.Diagnostic[]>(resolve => {
                process.nextTick(function () {
                    let diagnostics = service.getSemanticDiagnostics(fileName);
                    if (!originalCompilerOptions.declaration) {
                        // ignore declaration diagnostics if the user did not request declarations
                        diagnostics = diagnostics.filter(diagnostic => diagnostic.code < 4000 || diagnostic.code >= 5000);
                    }
                    resolve(diagnostics);
                });
            });
        }

        function emitSoon(fileName: string): Promise<{ fileName:string, signature: string, files: Vinyl[] }> {
            return new PromisePolyfill(resolve => {
                process.nextTick(function() {
                    if (/\.d\.ts$/.test(fileName)) {
                        // if it's already a d.ts file just emit its signature
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

                    if (hasEmittedSingleFileOutput) {
                        // if we have already emitted the single file output, just emit the
                        // saved signature.
                        return resolve({
                            fileName,
                            signature: singleFileSignature,
                            files: []
                        });
                    }

                    const input = getVinyl(fileName);
                    const output = service.getEmitOutput(fileName);
                    const files: Vinyl[] = [];
                    let signature: string | undefined;
                    let javaScriptFile: VinylFile | undefined;
                    let declarationFile: Vinyl | undefined;
                    let sourceMapFile: Vinyl | undefined;
                    if (!input) {
                        throw new Error('No input file found.');
                    }
                    for (const file of output.outputFiles) {
                        // When gulp-sourcemaps writes out a sourceMap, it uses the path
                        // information of the associated file. Specifically, it uses the base
                        // directory and relative path of the file to make decisions on how to
                        // write the "sources" and "sourceRoot" properties.
                        //
                        // To emit the correct paths, we need to have the output files emulate
                        // a path local to the source location, not the expected output location.
                        //
                        // Since gulp.dest sets our output location for us, then all that matters
                        // to gulp.dest is the relative path for each file. This means that we
                        // should be able to safely treat output files as local to sources to
                        // better support gulp-sourcemaps.
                        const base = (emitToSingleFile ? config.base : input.base) || '.';
                        const relative = path.relative(base, file.name);
                        const name = path.resolve(base, relative);
                        const contents = new Buffer(file.text);
                        const vinyl = new Vinyl({path: name, base, contents});
                        if (/\.js$/.test(vinyl.path)) {
                            javaScriptFile = vinyl;
                        }
                        else if (/\.js\.map$/.test(vinyl.path)) {
                            sourceMapFile = vinyl;
                        }
                        else if (/\.d\.ts$/.test(vinyl.path)) {
                            declarationFile = vinyl;
                        }
                    }

                    if (javaScriptFile) {
                        const sourceMappingURLPattern = /(\r\n?|\n)?\/\/# sourceMappingURL=[^\r\n]+(?=[\r\n\s]*$)/;
                        const contents = javaScriptFile.contents.toString();
                        javaScriptFile.contents = new Buffer(contents.replace(sourceMappingURLPattern, ""));
                        files.push(javaScriptFile);
                    }

                    if (declarationFile) {
                        signature = crypto.createHash('md5')
                            .update(declarationFile.contents)
                            .digest('base64');

                        if (originalCompilerOptions.declaration) {
                            // don't leak .d.ts files if users don't want them
                            files.push(declarationFile);
                        }
                    }

                    if (sourceMapFile) {
                        const capturedSourceFile = sourceMapFile;
                        // adjust the source map to be relative to the source directory.
                        const sourceMap = JSON.parse(sourceMapFile.contents.toString());
                        let sourceRoot: string | undefined = sourceMap.sourceRoot;
                        let sources: string[] = emitToSingleFile ? sourceMap.sources : [input.path];

                        const destPath = emitToSingleFile
                            ? path.dirname(path.resolve(config.base, originalCompilerOptions.outFile || originalCompilerOptions.out))
                            : path.resolve(config.base, originalCompilerOptions.outDir || ".");

                        // update sourceRoot
                        sourceRoot = emitSourceMapsInStream ? originalCompilerOptions.sourceRoot : sourceRoot;
                        sourceMap.sourceRoot = sourceRoot ? normalize(path.relative(destPath, sourceRoot)) : undefined;

                        // make all sources absolute
                        sources = sources.map(source => path.resolve(capturedSourceFile.base, source));

                        if (!javaScriptFile) {
                            throw new Error('Attempted to emit source map without source js file.');
                        }
                        if (emitSourceMapsInStream) {
                            // update sourcesContent
                            if (originalCompilerOptions.inlineSources) {
                                sourceMap.sourcesContent = sources.map(source => {
                                    const vinyl = getVinyl(source);
                                    return vinyl
                                        ? vinyl.contents.toString()
                                        : ts.sys.readFile(source);
                                });
                            }

                            // make all sources relative to the sourceRoot or destPath
                            sourceMap.sources = sources.map(source => {
                                source = path.resolve(capturedSourceFile.base, source);
                                source = path.relative(sourceRoot || destPath, source);
                                source = normalize(source);
                                return source;
                            });

                            const newLine = getNewLine();

                            // update the contents for the sourcemap file
                            sourceMapFile.contents = new Buffer(JSON.stringify(sourceMap).replace(/\r?\n/, newLine));

                            let contents = javaScriptFile.contents.toString();
                            if (originalCompilerOptions.inlineSourceMap) {
                                // restore the sourcemap as an inline source map in the javaScript file.
                                contents += newLine + "//# sourceMappingURL=data:application/json;charset=utf8;base64," + sourceMapFile.contents.toString("base64") + newLine;
                            }
                            else {
                                contents += newLine + "//# sourceMappingURL=" + normalize(path.relative(path.dirname(javaScriptFile.path), sourceMapFile.path)) + newLine;
                                files.push(sourceMapFile);
                            }

                            javaScriptFile.contents = new Buffer(contents);
                        }
                        else {
                            // sourceContent is handled by gulp-sourcemaps
                            sourceMap.sourcesContent = undefined;

                            // make all sources relative
                            sourceMap.sources = sources.map(source => {
                                const vinyl = emitToSingleFile ? getVinyl(source) : input;
                                return vinyl ? normalize(vinyl.relative) : source;
                            });

                            // set the javaScriptFile's sourceMap
                            javaScriptFile.sourceMap = sourceMap;
                        }
                    }

                    if (emitToSingleFile) {
                        hasEmittedSingleFileOutput = true;
                        singleFileSignature = signature;
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
        let hasEmittedSingleFileOutput = false;
        let singleFileSignature: string | undefined;

        for (let fileName of host.getScriptFileNames()) {
            if (lastBuildVersion[fileName] !== host.getScriptVersion(fileName)) {

                toBeEmitted.push(fileName);
                toBeCheckedSyntactically.push(fileName);
                toBeCheckedSemantically.push(fileName);
            }
        }

        return new PromisePolyfill(resolve => {

            let semanticCheckInfo = new Map<string, number>();
            let seenAsDependentFile = new Set<string>();

            function workOnNext() {

                let promise: Promise<any> | undefined;
                let fileName: string | undefined;

                // someone told us to stop this
                if (token.isCancellationRequested()) {
                    _log('[CANCEL]', '>>This compile run was cancelled<<')
                    newLastBuildVersion.clear();
                    resolve();
                    return;
                }

                // (1st) emit code
                else if (toBeEmitted.length) {
                    fileName = toBeEmitted.pop() as string;
                    const definiteFileName = fileName;
                    promise = emitSoon(definiteFileName).then(value => {

                        for (let file of value.files) {
                            _log('[emit code]', file.path);
                            out(file);
                        }

                        // remember when this was build
                        newLastBuildVersion.set(definiteFileName, host.getScriptVersion(definiteFileName));

                        // remeber the signature
                        if (value.signature && lastDtsHash[definiteFileName] !== value.signature) {
                            lastDtsHash[definiteFileName] = value.signature;
                            filesWithChangedSignature.push(definiteFileName);
                        }
                     });
                }

                // (2nd) check syntax
                else if (toBeCheckedSyntactically.length) {
                    fileName = toBeCheckedSyntactically.pop() as string;
                    const definiteFileName = fileName;
                    _log('[check syntax]', definiteFileName);
                    promise = checkSyntaxSoon(definiteFileName).then(diagnostics => {
                        delete oldErrors[definiteFileName];
                        if (diagnostics.length > 0) {
                            diagnostics.forEach(d => printDiagnostic(d, onError));
                            newErrors[definiteFileName] = diagnostics;

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
                        const definiteFileName = fileName;
                        _log('[check semantics]', definiteFileName);
                        promise = checkSemanticsSoon(definiteFileName).then(diagnostics => {
                            delete oldErrors[definiteFileName];
                            semanticCheckInfo.set(definiteFileName, diagnostics.length);
                            if (diagnostics.length > 0) {
                                diagnostics.forEach(d => printDiagnostic(d, onError));
                                newErrors[definiteFileName] = diagnostics;
                            }
                        });
                    }
                }

                // (4th) check dependents
                else if (filesWithChangedSignature.length) {
                    while (filesWithChangedSignature.length) {
                        let fileName = filesWithChangedSignature.pop() as string;

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
                    promise = PromisePolyfill.resolve();
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

class ScriptSnapshot implements ts.IScriptSnapshot {
    private _file: VinylFile;
    private _text: string;
    private _mtime: Date;

    constructor(file: VinylFile) {
        this._file = file;
        this._text = file.contents.toString("utf8");
        this._mtime = file.stat.mtime;
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

    public getChangeRange(oldSnapshot: ts.IScriptSnapshot): any {
        return null;
    }

    public getFile(): VinylFile {
        return this._file;
    }

    public getBase(): string {
        return this._file.base;
    }
}

class LanguageServiceHost implements ts.LanguageServiceHost {

    private _typescript: typeof ts;
    private _settings: ts.CompilerOptions;
    private _config: IConfiguration;
    private _noFilesystemLookup: boolean;
    private _snapshots: { [path: string]: ScriptSnapshot };
    private _roots: string[];
    private _projectVersion: number;
    private _dependencies: utils.graph.Graph<string>;
    private _dependenciesRecomputeList: string[];
    private _fileNameToDeclaredModule: { [path: string]: string[] };

    constructor(settings: ts.CompilerOptions, config: IConfiguration, noFilesystemLookup: boolean, typescript: typeof ts) {
        this._typescript = typescript;
        this._settings = settings;
        this._config = config;
        this._noFilesystemLookup = noFilesystemLookup;
        this._snapshots = Object.create(null);
        this._roots = [];
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

    getNewLine(): string {
        const ts = this._typescript;
        if (this._settings.newLine === ts.NewLineKind.CarriageReturnLineFeed) return "\r\n";
        if (this._settings.newLine === ts.NewLineKind.LineFeed) return "\n";
        if (ts.sys) return ts.sys.newLine;
        return "\r\n";
    }

    getScriptFileNames(): string[] {
        return this._roots.slice(0);
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
                result = new ScriptSnapshot(new Vinyl(<any> {
                    path: filename,
                    contents: readFileSync(filename),
                    base: this._config.base,
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

    addScriptSnapshot(filename: string, snapshot: ScriptSnapshot, isRoot?: boolean): ScriptSnapshot {
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
            let match: RegExpExecArray | null;
            while ((match = LanguageServiceHost._declareModule.exec(snapshot.getText(0, snapshot.getLength())))) {
                let declaredModules = this._fileNameToDeclaredModule[filename];
                if(!declaredModules) {
                    this._fileNameToDeclaredModule[filename] = declaredModules = [];
                }
                declaredModules.push(match[2]);
            }
        }
        this._snapshots[filename] = snapshot;
        if (isRoot && this._roots.indexOf(filename) === -1) {
            this._roots.push(filename);
        }
        return old;
    }

    removeScriptSnapshot(filename: string): boolean {
        this._projectVersion++;
        filename = normalize(filename);
        delete this._fileNameToDeclaredModule[filename];
        const index = this._roots.indexOf(filename);
        if (index >= 0) {
            this._roots.splice(index, 1);
        }
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

    getDefaultLibFileName(options: ts.CompilerOptions): string {
        const ts = this._typescript;
        const libFile = ts.getDefaultLibFileName(options);
        return normalize(require.resolve("typescript/lib/" + libFile));
    }

    // ---- dependency management

    collectDependents(filename: string, target: string[]): void {
        let file = this._dependenciesRecomputeList.length && this._dependenciesRecomputeList.pop();
        while (file) {
            this._processFile(file);
            file = this._dependenciesRecomputeList.pop();
        }
        filename = normalize(filename);
        var node = this._dependencies.lookup(filename);
        if (node) {
            utils.collections.forEach(node.incoming, entry => target.push(entry.key));
        }
    }

    _processFile(filename: string): void {
        const ts = this._typescript;
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
                    if(this._fileNameToDeclaredModule[key] && ~this._fileNameToDeclaredModule[key].indexOf(ref.fileName)) {
                        this._dependencies.inertEdge(filename, key);
                    }
                }
            }
        });
    }
}
