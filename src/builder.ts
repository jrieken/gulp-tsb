'use strict';

import { Stats, statSync, readFileSync, existsSync } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as utils from './utils';
import { EOL } from "os";
import { log, colors } from 'gulp-util';
import * as ts from 'typescript';
import Vinyl = require('vinyl');

export interface IConfiguration {
    json: boolean;
    noFilesystemLookup: boolean;
    verbose: boolean;
    base: string;
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

export function createTypeScriptBuilder(config: IConfiguration, compilerOptions: ts.CompilerOptions): ITypeScriptBuilder {
    // fix compiler options
    const originalCompilerOptions = utils.collections.structuredClone(compilerOptions);
    compilerOptions = fixCompilerOptions(config, utils.collections.structuredClone(compilerOptions));
    const host = createHost(compilerOptions, config.noFilesystemLookup || false);

    const newLine = getNewLine();
    let emitSourceMapsInStream = true;

    // Creates/ synchronizes the program
    let watch: ts.WatchOfFilesAndCompilerOptions;
    let fileListChanged = false;

    // Program and builder to emit/check files
    let program: ts.Program, usableOldBuilderState: ts.BuilderState;
    let toEmitFromBuilderState: ts.BuilderState;
    let headUsed = process.memoryUsage().heapUsed;
    return {
        file,
        build,
        getProgram: () => {
            synchronizeProgram();
            return program;
        }
    };

    function _log(topic: string, message: string) {
        if (config.verbose) {
            log(colors.cyan(topic), message);
        }
    }

    function printDiagnostics(diagnostics: ReadonlyArray<ts.Diagnostic>, onError: (err: any) => void) {
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

    function file(file: Vinyl) {
        // support gulp-sourcemaps
        if ((<any>file).sourceMap) {
            emitSourceMapsInStream = false;
        }

        fileListChanged = (!file.contents ? host.removeFile(file.path) : host.addFile(file)) || fileListChanged;
    }

    function getNewLine() {
        switch (compilerOptions.newLine) {
            case ts.NewLineKind.CarriageReturnLineFeed: return "\r\n";
            case ts.NewLineKind.LineFeed: return "\n";
            default: return EOL;
        }
    }

    function afterProgramCreate(_host: ts.DirectoryStructureHost, updatedProgram: ts.Program) {
        program = updatedProgram;
        if (toEmitFromBuilderState && toEmitFromBuilderState.canCreateNewStateFrom()) {
            usableOldBuilderState = toEmitFromBuilderState;
        }

        toEmitFromBuilderState = ts.createBuilderState(program, {
            computeHash: d => host.createHash(d),
            getCanonicalFileName: d => host.getCanonicalName(d)
        }, usableOldBuilderState);
    }

    function getSyntacticDiagnostics(file: ts.SourceFile) {
        return program.getSyntacticDiagnostics(file);
    }

    function getSemanticDiagnostics(file: ts.SourceFile) {
        return (toEmitFromBuilderState || usableOldBuilderState).getSemanticDiagnostics(program, file);
    }

    function emitNextAffectedFile(builderState: ts.BuilderState) {
        let files: Vinyl[] = [];

        let javaScriptFile: Vinyl;
        let sourceMapFile: Vinyl;

        const result = builderState.emitNextAffectedFile(program, writeFile);
        if (!result) {
            return undefined;
        }

        const { diagnostics, affectedFile } = result;
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
                    sourceMap.sourcesContent = sources.map(source => {
                        const vinyl = host.getFile(source);
                        return vinyl ? (<Buffer>vinyl.contents).toString("utf8") : ts.sys.readFile(source);
                    });
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
                    const vinyl = host.getFile(source);
                    return vinyl ? normalize(vinyl.relative) : source;
                });

                (<any>javaScriptFile).sourceMap = sourceMap;
            }
        }

        return { affectedFile, files, diagnostics };

        function writeFile(fileName: string, text: string, _writeByteOrderMark: boolean, _onError: (message: string) => void, sourceFiles: ts.SourceFile[]) {
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

            let base = sourceFiles.length === 1 && !config._emitWithoutBasePath ? host.getFile(sourceFiles[0].fileName).base : undefined;
            let relative = base && path.relative(base, fileName);
            let name = relative ? path.resolve(base, relative) : fileName;
            let contents = new Buffer(text);
            let vinyl = new Vinyl({ path: name, base, contents });
            if (/\.js$/.test(vinyl.path)) {
                javaScriptFile = vinyl;
                // gulp-sourcemaps will add an appropriate sourceMappingURL comment, so we need to remove the
                // one that TypeScript generates.
                const sourceMappingURLPattern = /(\r\n?|\n)?\/\/# sourceMappingURL=[^\r\n]+(?=[\r\n\s]*$)/;
                const contents = javaScriptFile.contents.toString();
                javaScriptFile.contents = new Buffer(contents.replace(sourceMappingURLPattern, ""));
                files.push(javaScriptFile);

            }
            else if (/\.js\.map$/.test(vinyl.path)) {
                sourceMapFile = vinyl;
            }
            else if (/\.d\.ts$/.test(vinyl.path)) {
                files.push(vinyl);
            }
        }
    }

    function createPromise<T, U>(arg: T, action: (arg: T) => U, onfulfilled: (result: U) => void, workOnNext: () => void) {
        return new Promise<U>(resolve => {
            process.nextTick(function () {
                resolve(action(arg));
            });
        }).then(onfulfilled).then(() => {
            // After completion, schedule next work
            process.nextTick(workOnNext);
        }).catch(err => {
            console.error(err);
        });;
    }

    function synchronizeProgram() {
        // Create/update the program
        if (!watch) {
            watch = ts.createWatch({
                system: host,
                beforeProgramCreate: utils.misc.noop,
                afterProgramCreate,
                rootFiles: host.getFileNames(),
                options: compilerOptions
            });
        }
        else if (fileListChanged) {
            fileListChanged = false;
            watch.updateRootFileNames(host.getFileNames());
        }
        else {
            watch.synchronizeProgram();
        }
    }

    function build(out: (file: Vinyl) => void, onError: (err: any) => void, token = CancellationToken.None): Promise<any> {
        let t1 = Date.now();

        enum Status { None, SyntaxCheck, SemanticCheck }
        let toCheckSyntaxOf: ts.SourceFile | undefined;
        let toCheckSemanticOf: ts.SourceFile | undefined;
        let sourceFilesToCheck: ts.SourceFile[] | undefined;
        let unrecoverableError = false;
        let rootFileNames: string[];
        let requireAffectedFileToBeRoot = watch === undefined;

        return new Promise(resolve => {
            rootFileNames = host.getFileNames();
            // Create/update the program
            synchronizeProgram();

            // Schedule next work
            host.updateWithProgram(program);
            sourceFilesToCheck = program.getSourceFiles().slice();
            workOnNext();

            function workOnNext() {
                if (!getNextWork(workOnNext)) {
                    resolve();
                }
            }
        }).then(() => {
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

        function setFileToCheck(file: ts.SourceFile, requiresToBeRoot: boolean) {
            if (!requiresToBeRoot || rootFileNames.findIndex(fileName => fileName === file.fileName) !== -1) {
                utils.maps.unorderedRemoveItem(rootFileNames, file.fileName);
                toCheckSyntaxOf = toCheckSemanticOf = file;
                return true;
            }

            return false;
        }

        function getNextWork(workOnNext: () => void): Promise<void> | undefined {
            // If unrecoverable error, stop
            if (unrecoverableError) {
                _log('[Syntax errors]', '>>Stopping the error check and file emit<<')
                return undefined;
            }

            // someone told us to stop this
            if (token.isCancellationRequested()) {
                _log('[CANCEL]', '>>This compile run was cancelled<<')
                return undefined;
            }

            // SyntaxCheck
            if (toCheckSyntaxOf) {
                const file = toCheckSyntaxOf;
                toCheckSyntaxOf = undefined;
                _log('[check syntax]', file.fileName);
                return createPromise(file, getSyntacticDiagnostics, diagnostics => {
                    printDiagnostics(diagnostics, onError);
                    unrecoverableError = diagnostics.length > 0;
                }, workOnNext);
            }

            // check semantics
            if (toCheckSemanticOf) {
                const file = toCheckSemanticOf;
                toCheckSemanticOf = undefined;
                _log('[check semantics]', file.fileName);
                return createPromise(file, getSemanticDiagnostics, diagnostics => printDiagnostics(diagnostics, onError), workOnNext);
            }

            // If there are pending files to emit, emit next file
            if (toEmitFromBuilderState) {
                return createPromise(toEmitFromBuilderState, emitNextAffectedFile, emitResult => {
                    if (!emitResult) {
                        // All emits complete, remove the toEmitFromBuilderState and
                        // set it as useOld
                        usableOldBuilderState = toEmitFromBuilderState;
                        toEmitFromBuilderState = undefined;
                        return;
                    }

                    const { affectedFile, diagnostics, files } = emitResult;
                    if (affectedFile && utils.maps.unorderedRemoveItem(sourceFilesToCheck, affectedFile)) {
                        // Set affected file to be checked for syntax and semantics
                        setFileToCheck(affectedFile, /*requiresToBeRoot*/ requireAffectedFileToBeRoot);
                    }

                    printDiagnostics(diagnostics, onError);
                    for (const file of files) {
                        _log('[emit code]', file.path);
                        out(file);
                    }

                }, workOnNext);
            }

            // Check remaining (non-affected files)
            while (sourceFilesToCheck.length) {
                const file = sourceFilesToCheck.pop();
                // Check only root file names - as thats what earlier happened
                if (setFileToCheck(file, /*requiresToBeRoot*/ true)) {
                    return getNextWork(workOnNext);
                }
            }

            // Report global diagnostics
            printDiagnostics(program.getOptionsDiagnostics(), onError);
            printDiagnostics(program.getGlobalDiagnostics(), onError);

            // Done
            return undefined;
        }
    }
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

interface Host extends ts.System {
    addFile(file: Vinyl): boolean;
    removeFile(filename: string): boolean;

    getFile(filename: string): Vinyl;
    getFileNames(): string[];

    updateWithProgram(program: ts.Program): void;

    getCanonicalName(s: string): string;
}

function createHost(options: ts.CompilerOptions, noFileSystemLookup: boolean): Host {
    const watchedFiles = utils.maps.createMultiMap<ts.FileWatcherCallback>();
    const watchedDirectories = utils.maps.createMultiMap<ts.DirectoryWatcherCallback>();
    const watchedDirectoriesRecursive = utils.maps.createMultiMap<ts.DirectoryWatcherCallback>();
    const files = utils.maps.createMap<VinylFile>();
    const useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames;
    const getCanonicalName: (s: string) => string = useCaseSensitiveFileNames ?
            ((fileName) => fileName) :
        ((fileName) => fileName.toLowerCase());

    const otherFiles = utils.maps.createMap<Vinyl>();

    return {
        addFile,
        removeFile,
        getFile,
        getFileNames,
        updateWithProgram,
        newLine: ts.sys.newLine,
        args: undefined,
        useCaseSensitiveFileNames,
        write: utils.misc.noop,
        readFile,
        writeFile: utils.misc.noop,
        fileExists,
        directoryExists,
        createDirectory: utils.misc.noop,
        getCurrentDirectory,
        getDirectories,
        readDirectory,
        exit: utils.misc.noop,
        watchFile,
        watchDirectory,
        resolvePath,
        getExecutingFilePath,
        createHash: s => ts.sys.createHash(s),
        getCanonicalName
    };

    function toPath(filename: string) {
        return resolvePath(getCanonicalName(normalize(filename)));
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

    function updateWithProgram(program: ts.Program) {
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

    function getExecutingFilePath(): string {
        // Executing from the typescript installation
        const typescriptInstall = require.resolve('typescript');
        return normalize(typescriptInstall);
    }
}