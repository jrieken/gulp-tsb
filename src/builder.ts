'use strict';

import { statSync, readFileSync, existsSync } from 'fs';
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
    base: string;
    ignoreWatchApi?: boolean;
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

    export const NoneTsToken: ts.CancellationToken = {
        isCancellationRequested() { return false },
        throwIfCancellationRequested: () => { }
    };

    export function createTsCancellationToken(token: CancellationToken): ts.CancellationToken {
        return {
            isCancellationRequested: () => token.isCancellationRequested(),
            throwIfCancellationRequested: () => {
                if (token.isCancellationRequested()) {
                    throw new ts.OperationCanceledException();
                }
            }
        };
    }
}

export interface ITypeScriptBuilder {
    build(out: (file: Vinyl) => void, onError: (err: any) => void, token?: CancellationToken): Promise<any>;
    file(file: Vinyl): void;
    getProgram(): ts.Program;
}

function normalize(path: string): string {
    return path.replace(/\\/g, '/');
}

function fixCompilerOptions(config: IConfiguration, compilerOptions: ts.CompilerOptions, setDeclaration: boolean) {
    // clean up compiler options that conflict with gulp
    if (compilerOptions.inlineSourceMap) compilerOptions.sourceMap = true;
    delete compilerOptions.inlineSourceMap; // handled by gulp-sourcemaps
    delete compilerOptions.inlineSources; // handled by gulp-sourcemaps
    delete compilerOptions.sourceRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.mapRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.outDir; // always emit relative to source file
    if (setDeclaration) {
        compilerOptions.declaration = true; // always emit declaration files
    }
    return compilerOptions;
}

enum Topics {
    Cancel = "[CANCEL]",
    EmitCode = "[emit code]",
    CheckSyntax = "[check syntax]",
    CheckSemantics = "[check semantics]",
    CheckSemanticsInfo = "[check semantics*]"
}

function _log(config: IConfiguration, topic: Topics, message: string): void {
    if (config.verbose) {
        log(colors.cyan(topic), message);
    }
}

function logCancel(config: IConfiguration) {
    _log(config, Topics.Cancel, ">>This compile run was cancelled<<");
}

function printDiagnostics(config: IConfiguration, diagnostics: ReadonlyArray<ts.Diagnostic>, onError: (err: any) => void) {
    if (diagnostics.length > 0) {
        diagnostics.forEach(diag => {
            let message: string;
            if (diag.file) {
                let lineAndCh = diag.file.getLineAndCharacterOfPosition(diag.start);
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
            }
            else {
                message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
                if (config.json) {
                    message = JSON.stringify({
                        message
                    });
                }
            }
            onError(message);
        });
    }
}

function getNewLine(compilerOptions: ts.CompilerOptions) {
    switch (compilerOptions.newLine) {
        case ts.NewLineKind.CarriageReturnLineFeed: return "\r\n";
        case ts.NewLineKind.LineFeed: return "\n";
        default: return EOL;
    }
}

function getDefaultLibFileName(options: ts.CompilerOptions): string {
    return normalize(path.join(getDefaultLibLocation(), ts.getDefaultLibFileName(options)));
}

function getDefaultLibLocation() {
    let typescriptInstall = require.resolve('typescript');
    return normalize(path.dirname(typescriptInstall));
}

function printStats(config: IConfiguration, existingHeapUsed: number, startTime: number) {
    // print stats
    if (config.verbose) {
        const headNow = process.memoryUsage().heapUsed,
            MB = 1024 * 1024;
        log('[tsb]',
            'time:', colors.yellow((Date.now() - startTime) + 'ms'),
            'mem:', colors.cyan(Math.ceil(headNow / MB) + 'MB'), colors.bgcyan('Δ' + Math.ceil((headNow - existingHeapUsed) / MB)));
        return headNow;
    }
}

function outFiles(config: IConfiguration, files: Vinyl[], out: (file: Vinyl) => void) {
    for (let file of files) {
        _log(config, Topics.EmitCode, file.path);
        out(file);
    }
}

interface EmitResult {
    signature: string;
    files: Vinyl[];
}

interface EmitVinyls {
    javaScriptFile?: Vinyl;
    sourceMapFile?: Vinyl;
    declarationFile?: Vinyl;
}

function updateEmitVinyl(config: IConfiguration, emitVinyls: EmitVinyls, base: string | undefined, fileName: string, text: string, ) {
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

    const relative = base && path.relative(base, fileName);
    const name = relative ? path.resolve(base, relative) : fileName;
    const contents = new Buffer(text);
    const vinyl = new Vinyl({ path: name, base, contents });
    if (/\.js$/.test(vinyl.path)) {
        emitVinyls.javaScriptFile = vinyl;
    }
    else if (/\.js\.map$/.test(vinyl.path)) {
        emitVinyls.sourceMapFile = vinyl;
    }
    else if (/\.d\.ts$/.test(vinyl.path)) {
        emitVinyls.declarationFile = vinyl;
    }
}

function getEmitResult(
    config: IConfiguration,
    emitSourceMapsInStream: boolean,
    originalCompilerOptions: Readonly<ts.CompilerOptions>,
    compilerOptions: ts.CompilerOptions,
    getSourceContent: (fileName: string) => string,
    getSourceVinyl: (fileName: string) => Vinyl | undefined,
    { javaScriptFile, declarationFile, sourceMapFile }: EmitVinyls,
    ignoreSignatureAndUseDeclarationFile?: boolean
): EmitResult {
    const files: Vinyl[] = [];
    let signature: string | undefined;
    if (javaScriptFile) {
        // gulp-sourcemaps will add an appropriate sourceMappingURL comment, so we need to remove the
        // one that TypeScript generates.
        const sourceMappingURLPattern = /(\r\n?|\n)?\/\/# sourceMappingURL=[^\r\n]+(?=[\r\n\s]*$)/;
        const contents = javaScriptFile.contents.toString();
        javaScriptFile.contents = new Buffer(contents.replace(sourceMappingURLPattern, ""));
        files.push(javaScriptFile);
    }

    if (declarationFile) {
        if (ignoreSignatureAndUseDeclarationFile) {
            files.push(declarationFile);
        }
        else {
            signature = crypto.createHash('md5')
                .update(declarationFile.contents as Buffer)
                .digest('base64');

            if (originalCompilerOptions.declaration) {
                // don't leak .d.ts files if users don't want them
                files.push(declarationFile);
            }
        }
    }

    if (sourceMapFile) {
        // adjust the source map to be relative to the source directory.
        const sourceMap = JSON.parse(sourceMapFile.contents.toString());
        let sourceRoot = sourceMap.sourceRoot;
        const sources = sourceMap.sources.map(source => path.resolve(sourceMapFile.base, source));
        const destPath = path.resolve(config.base, originalCompilerOptions.outDir || ".");

        // update sourceRoot to be relative from the expected destination path
        sourceRoot = emitSourceMapsInStream ? originalCompilerOptions.sourceRoot : sourceRoot;
        sourceMap.sourceRoot = sourceRoot ? normalize(path.relative(destPath, sourceRoot)) : undefined;

        if (emitSourceMapsInStream) {
            // update sourcesContent
            if (originalCompilerOptions.inlineSources) {
                sourceMap.sourcesContent = sources.map(getSourceContent);
            }

            // make all sources relative to the sourceRoot or destPath
            sourceMap.sources = sources.map(source => {
                source = path.resolve(sourceMapFile.base, source);
                source = path.relative(sourceRoot || destPath, source);
                source = normalize(source);
                return source;
            });

            // update the contents for the sourcemap file
            sourceMapFile.contents = new Buffer(JSON.stringify(sourceMap));

            const newLine = getNewLine(compilerOptions);
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
            // sourcesContent is handled by gulp-sourcemaps
            sourceMap.sourcesContent = undefined;

            // make all of the sources in the source map relative paths
            sourceMap.sources = sources.map(source => {
                const vinyl = getSourceVinyl(source);
                return vinyl ? normalize(vinyl.relative) : source;
            });

            (<any>javaScriptFile).sourceMap = sourceMap;
        }
    }

    return {
        files,
        signature
    };
}

interface Work<T = {}, U = {}> {
    arg: T;
    action: (arg: T, tsToken?: ts.CancellationToken) => U;
    onfulfilled: (result: U) => void;
}

function scheduleWork(
    config: IConfiguration,
    finalResolve: () => void,
    getNextWork: () => Work,
    tsToken?: ts.CancellationToken) {

    scheduleNextWork();

    function scheduleNextWork() {
        const work = getNextWork();
        if (work) {
            const { action, arg, onfulfilled } = work;
            return new Promise(resolve => {
                process.nextTick(function () {
                    resolve(action(arg, tsToken));
                });
            }).then(onfulfilled, err => {
                if (err instanceof ts.OperationCanceledException) {
                    logCancel(config);
                }
                console.error(err);
            }).then(() => {
                // After completion, schedule next work
                process.nextTick(scheduleNextWork);
            }).catch(err => {
                console.error(err);
            });
        }
        else {
            finalResolve();
        }
    }
}

export function createTypeScriptBuilder(config: IConfiguration, compilerOptions: ts.CompilerOptions): ITypeScriptBuilder {
    // fix compiler options
    const originalCompilerOptions = utils.collections.structuredClone(compilerOptions);
    const useWatchApi = !config.ignoreWatchApi && ts.createWatchProgram;
    compilerOptions = fixCompilerOptions(config, utils.collections.structuredClone(compilerOptions), !useWatchApi);

    if (useWatchApi) {
        return WatchApi.createTypeScriptBuilder(config, originalCompilerOptions, compilerOptions);
    }
    else {
        return LanguageServiceApi.createTypeScriptBuilder(config, originalCompilerOptions, compilerOptions);
    }
}

namespace WatchApi {
    interface EmitResult {
        affected: ts.SourceFile | ts.Program,
        files: Vinyl[];
        diagnostics: ReadonlyArray<ts.Diagnostic>;
    }

    export function createTypeScriptBuilder(config: IConfiguration, originalCompilerOptions: Readonly<ts.CompilerOptions>, compilerOptions: ts.CompilerOptions): ITypeScriptBuilder {
        const host = createHost(compilerOptions, config.noFilesystemLookup || false);
        let emitSourceMapsInStream = true;

        // Creates/ synchronizes the program
        let watch: ts.WatchOfFilesAndCompilerOptions<ts.EmitAndSemanticDiagnosticsBuilderProgram>;
        let fileListChanged = false;

        // Program and builder to emit/check files
        let heapUsed = process.memoryUsage().heapUsed;
        return {
            file,
            build,
            getProgram: () => getBuilderProgram().getProgram()
        };

        function file(file: Vinyl) {
            // support gulp-sourcemaps
            if ((<any>file).sourceMap) {
                emitSourceMapsInStream = false;
            }

            fileListChanged = (!file.contents ? host.removeFile(file.path) : host.addFile(file)) || fileListChanged;
        }

        function getBuilderProgram() {
            // Create/update the program
            if (!watch) {
                host.rootFiles = host.getFileNames();
                host.options = compilerOptions;
                watch = ts.createWatchProgram(host);
            }
            else if (fileListChanged) {
                fileListChanged = false;
                watch.updateRootFileNames(host.getFileNames());
            }
            return watch.getProgram();
        }

        function build(out: (file: Vinyl) => void, onError: (err: any) => void, token?: CancellationToken): Promise<any> {
            const startTime = Date.now();

            let toCheckSyntaxOf: ts.SourceFile | undefined;
            let toCheckSemanticOf: ts.SourceFile | undefined;
            let sourceFilesToCheck: ts.SourceFile[] | undefined;
            let unrecoverableError = false;
            let rootFileNames: string[];
            let requireAffectedFileToBeRoot = watch === undefined;
            // Check only root file names - as thats what earlier happened
            let requireRootForOtherFiles = true;
            let hasPendingEmit = true;
            const tsToken = token ? CancellationToken.createTsCancellationToken(token) : CancellationToken.NoneTsToken;
            let builderProgram: ts.EmitAndSemanticDiagnosticsBuilderProgram;

            return new Promise(resolve => {
                rootFileNames = host.getFileNames();
                // Create/update the program
                builderProgram = getBuilderProgram();
                host.updateWithProgram(builderProgram);

                // Schedule next work
                sourceFilesToCheck = builderProgram.getSourceFiles().slice();
                scheduleWork(config, resolve, getNextWork, tsToken);
            }).then(() => {
                // print stats
                heapUsed = printStats(config, heapUsed, startTime);
            });

            function getSyntacticDiagnostics(file: ts.SourceFile, token: ts.CancellationToken) {
                return builderProgram.getSyntacticDiagnostics(file, token);
            }

            function getSemanticDiagnostics(file: ts.SourceFile, token: ts.CancellationToken) {
                return builderProgram.getSemanticDiagnostics(file, token);
            }

            function emitNextAffectedFile(_arg: undefined, token: ts.CancellationToken): EmitResult {
                const emitVinyls: EmitVinyls = {};
                const result = builderProgram.emitNextAffectedFile(writeFile, token);
                if (!result) {
                    return undefined;
                }

                const { result: { diagnostics }, affected } = result;
                const { files } = getEmitResult(
                    config,
                    emitSourceMapsInStream,
                    originalCompilerOptions,
                    compilerOptions,
                    source => {
                        const vinyl = host.getFile(source);
                        return vinyl ? (<Buffer>vinyl.contents).toString("utf8") : ts.sys.readFile(source);
                    },
                    source => host.getFile(source),
                    emitVinyls,
                    /*ignoreSignatureAndUseDeclarationFile*/ true
                );

                return { affected, files, diagnostics };

                function writeFile(fileName: string, text: string, _writeByteOrderMark: boolean, _onError: (message: string) => void, sourceFiles: ts.SourceFile[]) {
                    updateEmitVinyl(config, emitVinyls, sourceFiles.length === 1 && !config._emitWithoutBasePath ? host.getFile(sourceFiles[0].fileName).base : undefined, fileName, text);
                }
            }

            function setFileToCheck(file: ts.SourceFile, requiresToBeRoot: boolean) {
                if (!requiresToBeRoot || rootFileNames.findIndex(fileName => fileName === file.fileName) !== -1) {
                    utils.maps.unorderedRemoveItem(rootFileNames, file.fileName);
                    toCheckSyntaxOf = toCheckSemanticOf = file;
                    return true;
                }

                return false;
            }

            function getNextWork(): Work | undefined {
                // If unrecoverable error, stop
                if (unrecoverableError) {
                    logCancel(config);
                    return undefined;
                }

                // someone told us to stop this
                if (tsToken.isCancellationRequested()) {
                    logCancel(config);
                    return undefined;
                }

                // SyntaxCheck
                if (toCheckSyntaxOf) {
                    const work: Work<ts.SourceFile, ReadonlyArray<ts.Diagnostic>> = {
                        arg: toCheckSyntaxOf,
                        action: getSyntacticDiagnostics,
                        onfulfilled: diagnostics => {
                            printDiagnostics(config, diagnostics, onError);
                            unrecoverableError = diagnostics.length > 0;
                        }
                    };
                    toCheckSyntaxOf = undefined;
                    _log(config, Topics.CheckSyntax, work.arg.fileName);
                    return work;
                }

                // check semantics
                if (toCheckSemanticOf) {
                    const work: Work<ts.SourceFile, ReadonlyArray<ts.Diagnostic>> = {
                        arg: toCheckSemanticOf,
                        action: getSemanticDiagnostics,
                        onfulfilled: diagnostics => printDiagnostics(config, diagnostics, onError)
                    };
                    toCheckSemanticOf = undefined;
                    _log(config, Topics.CheckSemantics, work.arg.fileName);
                    return work;
                }

                // If there are pending files to emit, emit next file
                if (hasPendingEmit) {
                    const work: Work<undefined, EmitResult> = {
                        arg: undefined,
                        action: emitNextAffectedFile,
                        onfulfilled: emitResult => {
                            if (!emitResult) {
                                // All emits complete, remove the toEmitFromBuilderState and
                                // set it as useOld
                                hasPendingEmit = false;
                                return;
                            }

                            const { affected, diagnostics, files } = emitResult;
                            if (isAffectedProgram(affected)) {
                                // Whole program is changed, syntax check for all the files with requireAffectedFileToBeRoot setting
                                requireRootForOtherFiles = requireAffectedFileToBeRoot;
                            }
                            else if (utils.maps.unorderedRemoveItem(sourceFilesToCheck, affected as ts.SourceFile)) {
                                // Set affected file to be checked for syntax and semantics
                                setFileToCheck(affected as ts.SourceFile, /*requiresToBeRoot*/ requireAffectedFileToBeRoot);
                            }

                            printDiagnostics(config, diagnostics, onError);
                            outFiles(config, files, out);
                        }
                    };
                    return work;
                }

                // Check remaining (non-affected files)
                while (sourceFilesToCheck.length) {
                    const file = sourceFilesToCheck.pop();
                    // Check only root file names - as thats what earlier happened
                    if (setFileToCheck(file, requireRootForOtherFiles)) {
                        return getNextWork();
                    }
                }

                // Report global diagnostics
                printDiagnostics(config, builderProgram.getOptionsDiagnostics(), onError);
                printDiagnostics(config, builderProgram.getGlobalDiagnostics(), onError);

                // Done
                return undefined;
            }
        }
    }

    function isAffectedProgram(affected: ts.SourceFile | ts.Program): affected is ts.Program {
        return (affected as ts.SourceFile).kind !== ts.SyntaxKind.SourceFile
    }

    interface VinylFile {
        file: Vinyl;
        text: string;
        mtime: Date;
        name: string;
    }

    function getTextOfVinyl(file: Vinyl) {
        return (<Buffer>file.contents).toString("utf8");
    }

    function createVinylFile(file: Vinyl): VinylFile {
        return {
            file,
            name: normalize(file.path),
            text: getTextOfVinyl(file),
            mtime: file.stat.mtime,
        };
    }

    interface Host extends ts.WatchCompilerHostOfFilesAndCompilerOptions<ts.EmitAndSemanticDiagnosticsBuilderProgram> {
        addFile(file: Vinyl): boolean;
        removeFile(filename: string): boolean;

        getFile(filename: string): Vinyl;
        getFileNames(): string[];

        updateWithProgram(program: ts.EmitAndSemanticDiagnosticsBuilderProgram): void;
    }

    function createHost(options: ts.CompilerOptions, noFileSystemLookup: boolean): Host {
        const watchedFiles = utils.maps.createMultiMap<ts.FileWatcherCallback>();
        const watchedDirectories = utils.maps.createMultiMap<ts.DirectoryWatcherCallback>();
        const watchedDirectoriesRecursive = utils.maps.createMultiMap<ts.DirectoryWatcherCallback>();
        const files = utils.maps.createMap<VinylFile>();
        const useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames;
        const getCanonicalFileName: (s: string) => string = useCaseSensitiveFileNames ?
            ((fileName) => fileName) :
            ((fileName) => fileName.toLowerCase());

        const otherFiles = utils.maps.createMap<Vinyl>();

        return {
            addFile,
            removeFile,
            getFile,
            getFileNames,
            updateWithProgram,
            createHash: data => ts.sys.createHash(data),

            useCaseSensitiveFileNames: () => useCaseSensitiveFileNames,
            getNewLine: () => ts.sys.newLine,
            getCurrentDirectory,
            getDefaultLibFileName,
            getDefaultLibLocation,
            fileExists,
            readFile,
            directoryExists,
            getDirectories,
            readDirectory,
            realpath: resolvePath,
            watchFile,
            watchDirectory,

            createProgram: ts.createEmitAndSemanticDiagnosticsBuilderProgram,

            // To be filled in later
            rootFiles: [],
            options: undefined,
        };

        function toPath(filename: string) {
            return resolvePath(getCanonicalFileName(normalize(filename)));
        }

        function addFile(file: Vinyl) {
            const filename = toPath(file.path);
            const existingFile = files.get(filename);
            if (existingFile) {
                const mtime = file.stat.mtime;
                if (existingFile.mtime !== mtime) {
                    existingFile.mtime = mtime;
                    const text = getTextOfVinyl(file);
                    if (file.text !== text) {
                        existingFile.text = text;
                        invokeFileWatcher(filename, ts.FileWatcherEventKind.Changed);
                    }
                }
            }
            else {
                otherFiles.delete(filename);
                files.set(filename, createVinylFile(file));
                invokeFileWatcher(filename, ts.FileWatcherEventKind.Created);
                invokeDirectoryWatcher(path.dirname(filename), filename);
                return true;
            }
        }

        function removeFile(filename: string) {
            filename = toPath(filename);
            if (files.has(filename)) {
                files.delete(filename);
                invokeFileWatcher(filename, ts.FileWatcherEventKind.Deleted);
                invokeDirectoryWatcher(path.dirname(filename), filename);
                return true;
            }
        }

        function getFile(filename: string) {
            filename = toPath(filename);
            const file = files.get(filename);
            return file && file.file || otherFiles.get(filename);
        }

        function getFileNames() {
            const result: string[] = [];
            files.forEach(file => {
                result.push(file.name);
            });
            return result;
        }

        function updateWithProgram(program: ts.EmitAndSemanticDiagnosticsBuilderProgram) {
            otherFiles.forEach((file, filename) => {
                if (!program.getSourceFile(file.path)) {
                    otherFiles.delete(filename);
                }
            });
        }

        function invokeWatcherCallbacks<T extends (fileName: string, anotherArg?: ts.FileWatcherEventKind) => void>(callbacks: T[], fileName: string, eventKind?: ts.FileWatcherEventKind) {
            if (callbacks) {
                // The array copy is made to ensure that even if one of the callback removes the callbacks,
                // we dont miss any callbacks following it
                const cbs = callbacks.slice();
                for (const cb of cbs) {
                    cb(fileName, eventKind);
                }
            }
        }

        function invokeFileWatcher(fileName: string, eventKind: ts.FileWatcherEventKind) {
            invokeWatcherCallbacks(watchedFiles.get(fileName), fileName, eventKind);
        }

        function invokeDirectoryWatcher(directory: string, fileAddedOrRemoved: string) {
            invokeWatcherCallbacks(watchedDirectories.get(directory), fileAddedOrRemoved);
            invokeRecursiveDirectoryWatcher(directory, fileAddedOrRemoved);
        }

        function invokeRecursiveDirectoryWatcher(directory: string, fileAddedOrRemoved: string) {
            invokeWatcherCallbacks(watchedDirectoriesRecursive.get(directory), fileAddedOrRemoved);
            const basePath = path.dirname(directory);
            if (directory !== basePath) {
                invokeRecursiveDirectoryWatcher(basePath, fileAddedOrRemoved);
            }
        }

        function readFile(path: string, encoding?: string) {
            const canonicalName = toPath(path);
            const file = files.get(canonicalName);
            if (file) {
                return file.text;
            }
            if (noFileSystemLookup) {
                return undefined;
            }
            const text = ts.sys.readFile(path, encoding);
            if (text !== undefined) {
                otherFiles.set(canonicalName, new Vinyl({
                    path,
                    contents: new Buffer(text),
                    base: options.outDir,
                    stat: statSync(path)
                }));
            }
            return text;
        }

        function fileExists(path: string) {
            return !!files.get(toPath(path)) || !noFileSystemLookup && ts.sys.fileExists(path);
        }

        function directoryExists(dir: string) {
            if (!noFileSystemLookup) {
                return ts.sys.directoryExists(dir);
            }

            dir = toPath(dir)
            return utils.maps.forEachEntry(files, (_file, filename) => dir === path.dirname(filename));
        }

        function getCurrentDirectory() {
            return process.cwd();
        }

        function getDirectories(path: string): string[] {
            return !noFileSystemLookup && ts.sys.getDirectories(path);
        }

        function readDirectory(path: string, extensions?: ReadonlyArray<string>, exclude?: ReadonlyArray<string>, include?: ReadonlyArray<string>, depth?: number): string[] {
            return !noFileSystemLookup && ts.sys.readDirectory(path, extensions, exclude, include, depth);
        }

        // NO fs watch
        function createWatcher<T>(path: string, map: utils.maps.MultiMap<T>, callback: T): ts.FileWatcher {
            path = toPath(path);
            map.add(path, callback);
            return {
                close: () => {
                    map.remove(path, callback);
                }
            };
        }

        function watchFile(path: string, callback: ts.FileWatcherCallback, pollingInterval?: number) {
            return createWatcher(path, watchedFiles, callback);
        }

        function watchDirectory(path: string, callback: ts.DirectoryWatcherCallback, recursive?: boolean) {
            return createWatcher(path, recursive ? watchedDirectoriesRecursive : watchedDirectories, callback);
        }

        function resolvePath(path: string) {
            return !noFileSystemLookup ? ts.sys.resolvePath(path) : path;
        }
    }
}

namespace LanguageServiceApi {
    export function createTypeScriptBuilder(config: IConfiguration, originalCompilerOptions: Readonly<ts.CompilerOptions>, compilerOptions: ts.CompilerOptions): ITypeScriptBuilder {
        let host = new LanguageServiceHost(compilerOptions, config.noFilesystemLookup || false),
            service = ts.createLanguageService(host, ts.createDocumentRegistry()),
            lastBuildVersion: { [path: string]: string } = Object.create(null),
            lastDtsHash: { [path: string]: string } = Object.create(null),
            oldErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null),
            heapUsed = process.memoryUsage().heapUsed,
            emitSourceMapsInStream = true;

        let semanticCheckInfo = new Map<string, number>();
        let seenAsDependentFile = new Set<string>();

        // always emit declaraction files
        host.getCompilationSettings().declaration = true;

        function file(file: Vinyl): void {
            // support gulp-sourcemaps
            if ((<any>file).sourceMap) {
                emitSourceMapsInStream = false;
            }

            if (!file.contents) {
                host.removeScriptSnapshot(file.path);
            } else {
                host.addScriptSnapshot(file.path, new ScriptSnapshot(file));
            }
        }

        function isExternalModule(sourceFile: ts.SourceFile): boolean {
            return (<any>sourceFile).externalModuleIndicator
                || /declare\s+module\s+('|")(.+)\1/.test(sourceFile.getText())
        }

        function build(out: (file: Vinyl) => void, onError: (err: any) => void, token = CancellationToken.None): Promise<any> {
            let newErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null);
            let startTime = Date.now();

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
                scheduleWork(config, resolve, getNextWork);
            }).then(() => {
                // store the build versions to not rebuilt the next time
                newLastBuildVersion.forEach((value, key) => {
                    lastBuildVersion[key] = value;
                });

                // print old errors and keep them
                utils.collections.forEach(oldErrors, entry => {
                    printDiagnostics(config, entry.value, onError);
                    newErrors[entry.key] = entry.value;
                });
                oldErrors = newErrors;

                // print stats
                heapUsed = printStats(config, heapUsed, startTime);
            });

            function getSyntacticDiagnostics(fileName: string) {
                return service.getSyntacticDiagnostics(fileName);
            }

            function getSemanticDiagnostics(fileName: string) {
                return service.getSemanticDiagnostics(fileName);
            }

            function emitFile(fileName: string): EmitResult {
                if (/\.d\.ts$/.test(fileName)) {
                    // if it's already a d.ts file just emit it signature
                    const snapshot = host.getScriptSnapshot(fileName);
                    const signature = crypto.createHash('md5')
                        .update(snapshot.getText(0, snapshot.getLength()))
                        .digest('base64');

                    return {
                        signature,
                        files: []
                    };
                }

                const input = host.getScriptSnapshot(fileName);
                const output = service.getEmitOutput(fileName);
                const emitVinyls: EmitVinyls = {};

                for (let file of output.outputFiles) {
                    updateEmitVinyl(config, emitVinyls, config._emitWithoutBasePath ? input.getBase() : undefined, file.name, file.text);
                }

                return getEmitResult(
                    config,
                    emitSourceMapsInStream,
                    originalCompilerOptions,
                    compilerOptions,
                    source => {
                        const snapshot = host.getScriptSnapshot(source) || input;
                        const vinyl = snapshot && snapshot.getFile();
                        return vinyl
                            ? (<Buffer>vinyl.contents).toString("utf8")
                            : ts.sys.readFile(source);
                    },
                    fileName => {
                        const snapshot = host.getScriptSnapshot(fileName) || input;
                        return snapshot && snapshot.getFile();
                    },
                    emitVinyls
                );
            }

            function getNextWork(): Work | undefined {
                while (true) {

                    // someone told us to stop this
                    if (token.isCancellationRequested()) {
                        logCancel(config);
                        newLastBuildVersion.clear();
                        return undefined;
                    }

                    // (1st) emit code
                    else if (toBeEmitted.length) {
                        const fileName = toBeEmitted.pop();
                        const work: Work<string, EmitResult> = {
                            arg: fileName,
                            action: emitFile,
                            onfulfilled: ({ files, signature }) => {
                                outFiles(config, files, out);

                                // remember when this was build
                                newLastBuildVersion.set(fileName, host.getScriptVersion(fileName));

                                // remeber the signature
                                if (signature && lastDtsHash[fileName] !== signature) {
                                    lastDtsHash[fileName] = signature;
                                    filesWithChangedSignature.push(fileName);
                                }
                            }
                        };
                        return work;
                    }

                    // (2nd) check syntax
                    else if (toBeCheckedSyntactically.length) {
                        const fileName = toBeCheckedSyntactically.pop();
                        _log(config, Topics.CheckSyntax, fileName);
                        const work: Work<string, ts.Diagnostic[]> = {
                            arg: fileName,
                            action: getSyntacticDiagnostics,
                            onfulfilled: diagnostics => {
                                delete oldErrors[fileName];
                                if (diagnostics.length > 0) {
                                    printDiagnostics(config, diagnostics, onError);
                                    newErrors[fileName] = diagnostics;

                                    // stop the world when there are syntax errors
                                    toBeCheckedSyntactically.length = 0;
                                    toBeCheckedSemantically.length = 0;
                                    filesWithChangedSignature.length = 0;
                                }
                            }
                        };
                        return work;
                    }

                    // (3rd) check semantics
                    else if (toBeCheckedSemantically.length) {

                        let fileName = toBeCheckedSemantically.pop();
                        while (fileName && semanticCheckInfo.has(fileName)) {
                            fileName = toBeCheckedSemantically.pop();
                        }

                        if (fileName) {
                            _log(config, Topics.CheckSemantics, fileName);
                            const work: Work<string, ts.Diagnostic[]> = {
                                arg: fileName,
                                action: getSemanticDiagnostics,
                                onfulfilled: diagnostics => {
                                    delete oldErrors[fileName];
                                    semanticCheckInfo.set(fileName, diagnostics.length);
                                    if (diagnostics.length > 0) {
                                        printDiagnostics(config, diagnostics, onError);
                                        newErrors[fileName] = diagnostics;
                                    }
                                }
                            }
                            return work;
                        }
                    }

                    // (4th) check dependents
                    else if (filesWithChangedSignature.length) {
                        while (filesWithChangedSignature.length) {
                            let fileName = filesWithChangedSignature.pop();

                            if (!isExternalModule(service.getProgram().getSourceFile(fileName))) {
                                _log(config, Topics.CheckSemanticsInfo, fileName + ' is an internal module and it has changed shape -> check whatever hasn\'t been checked yet');
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
                        let fileName = dependentFiles.pop();
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
                        return undefined;
                    }
                }
            }
        }

        return {
            file,
            build,
            getProgram: () => service.getProgram()
        };
    }

    class ScriptSnapshot implements ts.IScriptSnapshot {
        private _file: Vinyl;
        private _text: string;
        private _mtime: Date;

        constructor(file: Vinyl) {
            this._file = file;
            this._text = (<Buffer>file.contents).toString("utf8");
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

        public getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange {
            return null;
        }

        public getFile(): Vinyl {
            return this._file;
        }

        public getBase() {
            return this._file.base;
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
                    result = new ScriptSnapshot(new Vinyl(<any>{
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
            return getDefaultLibFileName(options);
        }

        getDefaultLibLocation() {
            return getDefaultLibLocation();
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
}
