'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
var fs_1 = require("fs");
var path = require("path");
var crypto = require("crypto");
var utils = require("./utils");
var os_1 = require("os");
var log = require("fancy-log");
var colors = require("ansi-colors");
var ts = require("typescript");
var Vinyl = require("vinyl");
var CancellationToken;
(function (CancellationToken) {
    CancellationToken.NoneTsToken = {
        isCancellationRequested: function () { return false; },
        throwIfCancellationRequested: function () { }
    };
    function createTsCancellationToken(token) {
        return {
            isCancellationRequested: function () { return token.isCancellationRequested(); },
            throwIfCancellationRequested: function () {
                if (token.isCancellationRequested()) {
                    throw new ts.OperationCanceledException();
                }
            }
        };
    }
    CancellationToken.createTsCancellationToken = createTsCancellationToken;
})(CancellationToken = exports.CancellationToken || (exports.CancellationToken = {}));
function normalize(path) {
    return path.replace(/\\/g, '/');
}
function fixCompilerOptions(config, compilerOptions) {
    // clean up compiler options that conflict with gulp
    if (compilerOptions.inlineSourceMap)
        compilerOptions.sourceMap = true;
    delete compilerOptions.inlineSourceMap; // handled by gulp-sourcemaps
    delete compilerOptions.inlineSources; // handled by gulp-sourcemaps
    delete compilerOptions.sourceRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.mapRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.outDir; // always emit relative to source file
    return compilerOptions;
}
var Topics;
(function (Topics) {
    Topics["Cancel"] = "[CANCEL]";
    Topics["EmitCode"] = "[emit code]";
    Topics["CheckSyntax"] = "[check syntax]";
    Topics["CheckSemantics"] = "[check semantics]";
    Topics["CheckSemanticsInfo"] = "[check semantics*]";
})(Topics || (Topics = {}));
function _log(config, topic, message) {
    if (config.verbose) {
        log(colors.cyan(topic), message);
    }
}
function logCancel(config) {
    _log(config, Topics.Cancel, ">>This compile run was cancelled<<");
}
function printDiagnostics(config, diagnostics, onError) {
    if (diagnostics.length > 0) {
        diagnostics.forEach(function (diag) {
            var message;
            if (diag.file) {
                var lineAndCh = diag.file.getLineAndCharacterOfPosition(diag.start);
                if (!config.json) {
                    message = utils.strings.format('{0}({1},{2}): {3}', diag.file.fileName, lineAndCh.line + 1, lineAndCh.character + 1, ts.flattenDiagnosticMessageText(diag.messageText, '\n'));
                }
                else {
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
                        message: message
                    });
                }
            }
            onError(message);
        });
    }
}
function getNewLine(compilerOptions) {
    switch (compilerOptions.newLine) {
        case ts.NewLineKind.CarriageReturnLineFeed: return "\r\n";
        case ts.NewLineKind.LineFeed: return "\n";
        default: return os_1.EOL;
    }
}
function getDefaultLibFileName(options) {
    return normalize(path.join(getDefaultLibLocation(), ts.getDefaultLibFileName(options)));
}
function getDefaultLibLocation() {
    var typescriptInstall = require.resolve('typescript');
    return normalize(path.dirname(typescriptInstall));
}
function printStats(config, existingHeapUsed, startTime) {
    // print stats
    if (config.verbose) {
        var headNow = process.memoryUsage().heapUsed, MB = 1024 * 1024;
        log('[tsb]', 'time:', colors.yellow((Date.now() - startTime) + 'ms'), 'mem:', colors.cyan(Math.ceil(headNow / MB) + 'MB'), colors.bgcyan('Δ' + Math.ceil((headNow - existingHeapUsed) / MB)));
        return headNow;
    }
}
function outFiles(config, files, out) {
    for (var _i = 0, files_1 = files; _i < files_1.length; _i++) {
        var file = files_1[_i];
        _log(config, Topics.EmitCode, file.path);
        out(file);
    }
}
function updateEmitVinyl(config, emitVinyls, base, fileName, text) {
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
    var relative = base && path.relative(base, fileName);
    var name = relative ? path.resolve(base, relative) : fileName;
    var contents = new Buffer(text);
    var vinyl = new Vinyl({ path: name, base: base, contents: contents });
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
function getEmitResult(config, emitSourceMapsInStream, originalCompilerOptions, compilerOptions, getSourceContent, getSourceVinyl, _a, ignoreSignatureAndUseDeclarationFile) {
    var javaScriptFile = _a.javaScriptFile, declarationFile = _a.declarationFile, sourceMapFile = _a.sourceMapFile;
    var files = [];
    var signature;
    if (javaScriptFile) {
        // gulp-sourcemaps will add an appropriate sourceMappingURL comment, so we need to remove the
        // one that TypeScript generates.
        var sourceMappingURLPattern = /(\r\n?|\n)?\/\/# sourceMappingURL=[^\r\n]+(?=[\r\n\s]*$)/;
        var contents = javaScriptFile.contents.toString();
        javaScriptFile.contents = new Buffer(contents.replace(sourceMappingURLPattern, ""));
        files.push(javaScriptFile);
    }
    if (declarationFile) {
        if (ignoreSignatureAndUseDeclarationFile) {
            files.push(declarationFile);
        }
        else {
            signature = crypto.createHash('md5')
                .update(declarationFile.contents)
                .digest('base64');
            if (originalCompilerOptions.declaration) {
                // don't leak .d.ts files if users don't want them
                files.push(declarationFile);
            }
        }
    }
    if (sourceMapFile) {
        // adjust the source map to be relative to the source directory.
        var sourceMap = JSON.parse(sourceMapFile.contents.toString());
        var sourceRoot_1 = sourceMap.sourceRoot;
        var sources = sourceMap.sources.map(function (source) { return path.resolve(sourceMapFile.base, source); });
        var destPath_1 = path.resolve(config.base, originalCompilerOptions.outDir || ".");
        // update sourceRoot to be relative from the expected destination path
        sourceRoot_1 = emitSourceMapsInStream ? originalCompilerOptions.sourceRoot : sourceRoot_1;
        sourceMap.sourceRoot = sourceRoot_1 ? normalize(path.relative(destPath_1, sourceRoot_1)) : undefined;
        if (emitSourceMapsInStream) {
            // update sourcesContent
            if (originalCompilerOptions.inlineSources) {
                sourceMap.sourcesContent = sources.map(getSourceContent);
            }
            // make all sources relative to the sourceRoot or destPath
            sourceMap.sources = sources.map(function (source) {
                source = path.resolve(sourceMapFile.base, source);
                source = path.relative(sourceRoot_1 || destPath_1, source);
                source = normalize(source);
                return source;
            });
            // update the contents for the sourcemap file
            sourceMapFile.contents = new Buffer(JSON.stringify(sourceMap));
            var newLine = getNewLine(compilerOptions);
            var contents = javaScriptFile.contents.toString();
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
            sourceMap.sources = sources.map(function (source) {
                var vinyl = getSourceVinyl(source);
                return vinyl ? normalize(vinyl.relative) : source;
            });
            javaScriptFile.sourceMap = sourceMap;
        }
    }
    return {
        files: files,
        signature: signature
    };
}
function scheduleWork(config, finalResolve, getNextWork, tsToken) {
    scheduleNextWork();
    function scheduleNextWork() {
        var work = getNextWork();
        if (work) {
            var action_1 = work.action, arg_1 = work.arg, onfulfilled = work.onfulfilled;
            return new Promise(function (resolve) {
                process.nextTick(function () {
                    resolve(action_1(arg_1, tsToken));
                });
            }).then(onfulfilled, function (err) {
                if (err instanceof ts.OperationCanceledException) {
                    logCancel(config);
                }
                console.error(err);
            }).then(function () {
                // After completion, schedule next work
                process.nextTick(scheduleNextWork);
            }).catch(function (err) {
                console.error(err);
            });
        }
        else {
            finalResolve();
        }
    }
}
function createTypeScriptBuilder(config, compilerOptions) {
    // fix compiler options
    var originalCompilerOptions = utils.collections.structuredClone(compilerOptions);
    compilerOptions = fixCompilerOptions(config, utils.collections.structuredClone(compilerOptions));
    return WatchApi.createTypeScriptBuilder(config, originalCompilerOptions, compilerOptions);
}
exports.createTypeScriptBuilder = createTypeScriptBuilder;
var WatchApi;
(function (WatchApi) {
    function createTypeScriptBuilder(config, originalCompilerOptions, compilerOptions) {
        var host = createHost(compilerOptions, config.noFilesystemLookup || false);
        var emitSourceMapsInStream = true;
        // Creates/ synchronizes the program
        var watch;
        var fileListChanged = false;
        // Program and builder to emit/check files
        var heapUsed = process.memoryUsage().heapUsed;
        return {
            file: file,
            build: build,
            getProgram: function () { return getBuilderProgram().getProgram(); }
        };
        function file(file) {
            // support gulp-sourcemaps
            if (file.sourceMap) {
                emitSourceMapsInStream = false;
            }
            fileListChanged = (!file.contents ? host.removeFile(file.path) : host.addFile(file)) || fileListChanged;
        }
        function getRootNames(host) {
            var fileNames = host.getFileNames();
            var allowedExtensions = compilerOptions.allowJs ? /(\.d\.ts|\.[tj]sx?)$/ : /(\.d\.ts|\.tsx?)$/;
            var rootNames = [];
            for (var _i = 0, fileNames_1 = fileNames; _i < fileNames_1.length; _i++) {
                var file_1 = fileNames_1[_i];
                if (allowedExtensions.test(file_1) && (!config.excludeNodeModulesFromRootNames || !/[\\/]node_modules[\\/]/.test(file_1))) {
                    rootNames.push(file_1);
                }
            }
            return rootNames;
        }
        function getBuilderProgram() {
            // Create/update the program
            if (!watch) {
                host.rootFiles = getRootNames(host);
                host.options = compilerOptions;
                watch = ts.createWatchProgram(host);
            }
            else if (fileListChanged) {
                fileListChanged = false;
                watch.updateRootFileNames(getRootNames(host));
            }
            return watch.getProgram();
        }
        function build(out, onError, token) {
            var startTime = Date.now();
            var toCheckSyntaxOf;
            var toCheckSemanticOf;
            var sourceFilesToCheck;
            var unrecoverableError = false;
            var rootFileNames;
            var requireAffectedFileToBeRoot = watch === undefined;
            // Check only root file names - as thats what earlier happened
            var requireRootForOtherFiles = true;
            var hasPendingEmit = true;
            var tsToken = token ? CancellationToken.createTsCancellationToken(token) : CancellationToken.NoneTsToken;
            var builderProgram;
            return new Promise(function (resolve) {
                rootFileNames = getRootNames(host);
                // Create/update the program
                builderProgram = getBuilderProgram();
                host.updateWithProgram(builderProgram);
                // Schedule next work
                sourceFilesToCheck = builderProgram.getSourceFiles().slice();
                scheduleWork(config, resolve, getNextWork, tsToken);
            }).then(function () {
                // print stats
                heapUsed = printStats(config, heapUsed, startTime);
            });
            function getSyntacticDiagnostics(file, token) {
                return builderProgram.getSyntacticDiagnostics(file, token);
            }
            function getSemanticDiagnostics(file, token) {
                return builderProgram.getSemanticDiagnostics(file, token);
            }
            function emitNextAffectedFile(_arg, token) {
                var emitVinyls = {};
                var result = builderProgram.emitNextAffectedFile(writeFile, token);
                if (!result) {
                    return undefined;
                }
                var diagnostics = result.result.diagnostics, affected = result.affected;
                var files = getEmitResult(config, emitSourceMapsInStream, originalCompilerOptions, compilerOptions, function (source) {
                    var vinyl = host.getFile(source);
                    return vinyl ? vinyl.contents.toString("utf8") : ts.sys.readFile(source);
                }, function (source) { return host.getFile(source); }, emitVinyls, 
                /*ignoreSignatureAndUseDeclarationFile*/ true).files;
                return { affected: affected, files: files, diagnostics: diagnostics };
                function writeFile(fileName, text, _writeByteOrderMark, _onError, sourceFiles) {
                    updateEmitVinyl(config, emitVinyls, sourceFiles.length === 1 && !config._emitWithoutBasePath ? host.getFile(sourceFiles[0].fileName).base : undefined, fileName, text);
                }
            }
            function setFileToCheck(file, requiresToBeRoot) {
                if (!requiresToBeRoot || rootFileNames.findIndex(function (fileName) { return fileName === file.fileName; }) !== -1) {
                    utils.maps.unorderedRemoveItem(rootFileNames, file.fileName);
                    toCheckSyntaxOf = toCheckSemanticOf = file;
                    return true;
                }
                return false;
            }
            function getNextWork() {
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
                    var work = {
                        arg: toCheckSyntaxOf,
                        action: getSyntacticDiagnostics,
                        onfulfilled: function (diagnostics) {
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
                    var work = {
                        arg: toCheckSemanticOf,
                        action: getSemanticDiagnostics,
                        onfulfilled: function (diagnostics) { return printDiagnostics(config, diagnostics, onError); }
                    };
                    toCheckSemanticOf = undefined;
                    _log(config, Topics.CheckSemantics, work.arg.fileName);
                    return work;
                }
                // If there are pending files to emit, emit next file
                if (hasPendingEmit) {
                    var work = {
                        arg: undefined,
                        action: emitNextAffectedFile,
                        onfulfilled: function (emitResult) {
                            if (!emitResult) {
                                // All emits complete, remove the toEmitFromBuilderState and
                                // set it as useOld
                                hasPendingEmit = false;
                                return;
                            }
                            var affected = emitResult.affected, diagnostics = emitResult.diagnostics, files = emitResult.files;
                            if (isAffectedProgram(affected)) {
                                // Whole program is changed, syntax check for all the files with requireAffectedFileToBeRoot setting
                                requireRootForOtherFiles = requireAffectedFileToBeRoot;
                            }
                            else if (utils.maps.unorderedRemoveItem(sourceFilesToCheck, affected)) {
                                // Set affected file to be checked for syntax and semantics
                                setFileToCheck(affected, /*requiresToBeRoot*/ requireAffectedFileToBeRoot);
                            }
                            printDiagnostics(config, diagnostics, onError);
                            outFiles(config, files, out);
                        }
                    };
                    return work;
                }
                // Check remaining (non-affected files)
                while (sourceFilesToCheck.length) {
                    var file_2 = sourceFilesToCheck.pop();
                    // Check only root file names - as thats what earlier happened
                    if (setFileToCheck(file_2, requireRootForOtherFiles)) {
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
    WatchApi.createTypeScriptBuilder = createTypeScriptBuilder;
    function isAffectedProgram(affected) {
        return affected.kind !== ts.SyntaxKind.SourceFile;
    }
    function getTextOfVinyl(file) {
        return file.contents.toString("utf8");
    }
    function createVinylFile(file) {
        return {
            file: file,
            name: normalize(file.path),
            text: getTextOfVinyl(file),
            mtime: file.stat.mtime,
        };
    }
    function createHost(options, noFileSystemLookup) {
        var watchedFiles = utils.maps.createMultiMap();
        var watchedDirectories = utils.maps.createMultiMap();
        var watchedDirectoriesRecursive = utils.maps.createMultiMap();
        var files = utils.maps.createMap();
        var useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames;
        var getCanonicalFileName = useCaseSensitiveFileNames ?
            (function (fileName) { return fileName; }) :
            (function (fileName) { return fileName.toLowerCase(); });
        var otherFiles = utils.maps.createMap();
        return {
            addFile: addFile,
            removeFile: removeFile,
            getFile: getFile,
            getFileNames: getFileNames,
            updateWithProgram: updateWithProgram,
            createHash: function (data) { return ts.sys.createHash(data); },
            useCaseSensitiveFileNames: function () { return useCaseSensitiveFileNames; },
            getNewLine: function () { return ts.sys.newLine; },
            getCurrentDirectory: getCurrentDirectory,
            getDefaultLibFileName: getDefaultLibFileName,
            getDefaultLibLocation: getDefaultLibLocation,
            fileExists: fileExists,
            readFile: readFile,
            directoryExists: directoryExists,
            getDirectories: getDirectories,
            readDirectory: readDirectory,
            realpath: resolvePath,
            watchFile: watchFile,
            watchDirectory: watchDirectory,
            createProgram: ts.createEmitAndSemanticDiagnosticsBuilderProgram,
            // To be filled in later
            rootFiles: [],
            options: undefined,
        };
        function toPath(filename) {
            return resolvePath(getCanonicalFileName(normalize(filename)));
        }
        function addFile(file) {
            var filename = toPath(file.path);
            var existingFile = files.get(filename);
            if (existingFile) {
                var mtime = file.stat.mtime;
                if (existingFile.mtime !== mtime) {
                    existingFile.mtime = mtime;
                    var text = getTextOfVinyl(file);
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
        function removeFile(filename) {
            filename = toPath(filename);
            if (files.has(filename)) {
                files.delete(filename);
                invokeFileWatcher(filename, ts.FileWatcherEventKind.Deleted);
                invokeDirectoryWatcher(path.dirname(filename), filename);
                return true;
            }
        }
        function getFile(filename) {
            filename = toPath(filename);
            var file = files.get(filename);
            return file && file.file || otherFiles.get(filename);
        }
        function getFileNames() {
            var result = [];
            files.forEach(function (file) {
                result.push(file.name);
            });
            return result;
        }
        function updateWithProgram(program) {
            otherFiles.forEach(function (file, filename) {
                if (!program.getSourceFile(file.path)) {
                    otherFiles.delete(filename);
                }
            });
        }
        function invokeWatcherCallbacks(callbacks, fileName, eventKind) {
            if (callbacks) {
                // The array copy is made to ensure that even if one of the callback removes the callbacks,
                // we dont miss any callbacks following it
                var cbs = callbacks.slice();
                for (var _i = 0, cbs_1 = cbs; _i < cbs_1.length; _i++) {
                    var cb = cbs_1[_i];
                    cb(fileName, eventKind);
                }
            }
        }
        function invokeFileWatcher(fileName, eventKind) {
            invokeWatcherCallbacks(watchedFiles.get(fileName), fileName, eventKind);
        }
        function invokeDirectoryWatcher(directory, fileAddedOrRemoved) {
            invokeWatcherCallbacks(watchedDirectories.get(directory), fileAddedOrRemoved);
            invokeRecursiveDirectoryWatcher(directory, fileAddedOrRemoved);
        }
        function invokeRecursiveDirectoryWatcher(directory, fileAddedOrRemoved) {
            invokeWatcherCallbacks(watchedDirectoriesRecursive.get(directory), fileAddedOrRemoved);
            var basePath = path.dirname(directory);
            if (directory !== basePath) {
                invokeRecursiveDirectoryWatcher(basePath, fileAddedOrRemoved);
            }
        }
        function readFile(path, encoding) {
            var canonicalName = toPath(path);
            var file = files.get(canonicalName);
            if (file) {
                return file.text;
            }
            if (noFileSystemLookup) {
                return undefined;
            }
            var text = ts.sys.readFile(path, encoding);
            if (text !== undefined) {
                otherFiles.set(canonicalName, new Vinyl({
                    path: path,
                    contents: new Buffer(text),
                    base: options.outDir,
                    stat: fs_1.statSync(path)
                }));
            }
            return text;
        }
        function fileExists(path) {
            return !!files.get(toPath(path)) || !noFileSystemLookup && ts.sys.fileExists(path);
        }
        function directoryExists(dir) {
            if (!noFileSystemLookup) {
                return ts.sys.directoryExists(dir);
            }
            dir = toPath(dir);
            return utils.maps.forEachEntry(files, function (_file, filename) { return dir === path.dirname(filename); });
        }
        function getCurrentDirectory() {
            return process.cwd();
        }
        function addTrailingDirectorySeparator(file) {
            return file && file.charAt(file.length - 1) !== '/' ? file + '/' : file;
        }
        function getDirectories(dir) {
            if (!noFileSystemLookup) {
                return ts.sys.getDirectories(dir);
            }
            dir = addTrailingDirectorySeparator(toPath(dir));
            var directories = [];
            utils.maps.forEachEntry(files, function (_file, filename) {
                if (dir === addTrailingDirectorySeparator(toPath(path.dirname(filename)))) {
                    // files are not directories
                    return;
                }
                if (filename.length > dir.length && filename.slice(0, dir.length) === dir) {
                    // the file's path is beneath the directory
                    var relative = filename.slice(dir.length);
                    var name_1 = relative.slice(0, relative.indexOf('/'));
                    if (name_1) {
                        directories.push(name_1);
                    }
                }
            });
            return directories;
        }
        function readDirectory(path, extensions, exclude, include, depth) {
            return !noFileSystemLookup && ts.sys.readDirectory(path, extensions, exclude, include, depth);
        }
        // NO fs watch
        function createWatcher(path, map, callback) {
            path = toPath(path);
            map.add(path, callback);
            return {
                close: function () {
                    map.remove(path, callback);
                }
            };
        }
        function watchFile(path, callback, pollingInterval) {
            return createWatcher(path, watchedFiles, callback);
        }
        function watchDirectory(path, callback, recursive) {
            return createWatcher(path, recursive ? watchedDirectoriesRecursive : watchedDirectories, callback);
        }
        function resolvePath(path) {
            return !noFileSystemLookup ? ts.sys.resolvePath(path) : path;
        }
    }
})(WatchApi || (WatchApi = {}));
