'use strict';

import { statSync } from 'fs';
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
    _emitWithoutBasePath?: boolean;
}

export interface CancellationToken {
    isCancellationRequested(): boolean;
}

export namespace CancellationToken {

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

function fixCompilerOptions(config: IConfiguration, compilerOptions: ts.CompilerOptions) {
    // clean up compiler options that conflict with gulp
    if (compilerOptions.inlineSourceMap) compilerOptions.sourceMap = true;
    delete compilerOptions.inlineSourceMap; // handled by gulp-sourcemaps
    delete compilerOptions.inlineSources; // handled by gulp-sourcemaps
    delete compilerOptions.sourceRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.mapRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.outDir; // always emit relative to source file
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
    const originalCompilerOptions = utils.collections.structuredClone(compilerOptions)
    compilerOptions = fixCompilerOptions(config, utils.collections.structuredClone(compilerOptions));

    return WatchApi.createTypeScriptBuilder(config, originalCompilerOptions, compilerOptions);
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
