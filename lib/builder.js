/// <reference types="node" />
'use strict';
var Vinyl = require("vinyl");
var path = require("path");
var crypto = require("crypto");
var utils = require("./utils");
var ts = require("typescript");
var os_1 = require("os");
var gulp_util_1 = require("gulp-util");
var fs_1 = require("fs");
var structuredClone = utils.collections.structuredClone;
var PromisePolyfill = require('pinkie-promise');
var CancellationToken;
(function (CancellationToken) {
    CancellationToken.None = {
        isCancellationRequested: function () { return false; }
    };
})(CancellationToken = exports.CancellationToken || (exports.CancellationToken = {}));
function normalize(path) {
    return path.replace(/\\/g, '/');
}
function getTypeScript(config) {
    return config.typescript || ts;
}
exports.getTypeScript = getTypeScript;
function createTypeScriptBuilder(config, compilerOptions) {
    // TODO(rbuckton): support url sourceRoot
    // TODO(rbuckton): support url mapRoot
    // TODO(rbuckton): support mapRoot
    var ts = getTypeScript(config);
    var originalCompilerOptions = structuredClone(compilerOptions);
    compilerOptions = structuredClone(compilerOptions);
    var outFile = compilerOptions.outFile || compilerOptions.out;
    if (outFile) {
        // always treat out file as relative to the root of the sources.
        compilerOptions.outFile = path.resolve(config.base, path.basename(outFile));
    }
    // clean up compiler options that conflict with gulp
    if (compilerOptions.inlineSourceMap)
        compilerOptions.sourceMap = true;
    delete compilerOptions.inlineSourceMap; // handled by gulp-sourcemaps or explicitly.
    delete compilerOptions.inlineSources; // handled by gulp-sourcemaps or explicitly.
    delete compilerOptions.sourceRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.mapRoot; // incompatible with gulp-sourcemaps
    delete compilerOptions.outDir; // always emit relative to source file
    delete compilerOptions.out; // outFile is preferred, see above
    compilerOptions.declaration = true; // always emit declaraction files
    var host = new LanguageServiceHost(compilerOptions, config, config.noFilesystemLookup || false, ts), service = ts.createLanguageService(host, ts.createDocumentRegistry()), lastBuildVersion = Object.create(null), lastDtsHash = Object.create(null), oldErrors = Object.create(null), headUsed = process.memoryUsage().heapUsed, emitSourceMapsInStream = true, emitToSingleFile = !!compilerOptions.outFile;
    function _log(topic, message) {
        if (config.verbose) {
            gulp_util_1.log(gulp_util_1.colors.cyan(topic), message);
        }
    }
    function printDiagnostic(diag, onError) {
        var lineAndCh = diag.file.getLineAndCharacterOfPosition(diag.start), message;
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
        onError(message);
    }
    function file(file) {
        // support gulp-sourcemaps
        if (file.sourceMap && emitSourceMapsInStream) {
            emitSourceMapsInStream = false;
        }
        if (!file.contents) {
            host.removeScriptSnapshot(file.path);
        }
        else {
            host.addScriptSnapshot(file.path, new ScriptSnapshot(file), /*isRoot*/ true);
        }
    }
    function isExternalModule(sourceFile) {
        return sourceFile.externalModuleIndicator
            || /declare\s+module\s+('|")(.+)\1/.test(sourceFile.getText());
    }
    function getVinyl(fileName, base) {
        if (base)
            fileName = path.resolve(base, fileName);
        var snapshot = host.getScriptSnapshot(fileName);
        if (snapshot instanceof ScriptSnapshot) {
            return snapshot.getFile();
        }
    }
    function getNewLine() {
        switch (compilerOptions.newLine) {
            case ts.NewLineKind.CarriageReturnLineFeed: return "\r\n";
            case ts.NewLineKind.LineFeed: return "\n";
            default: return os_1.EOL;
        }
    }
    function build(out, onError, token) {
        if (token === void 0) { token = CancellationToken.None; }
        function checkSyntaxSoon(fileName) {
            return new PromisePolyfill(function (resolve) {
                process.nextTick(function () {
                    resolve(service.getSyntacticDiagnostics(fileName));
                });
            });
        }
        function checkSemanticsSoon(fileName) {
            return new PromisePolyfill(function (resolve) {
                process.nextTick(function () {
                    var diagnostics = service.getSemanticDiagnostics(fileName);
                    if (!originalCompilerOptions.declaration) {
                        // ignore declaration diagnostics if the user did not request declarations
                        diagnostics = diagnostics.filter(function (diagnostic) { return diagnostic.code < 4000 || diagnostic.code >= 5000; });
                    }
                    resolve(diagnostics);
                });
            });
        }
        function emitSoon(fileName) {
            return new PromisePolyfill(function (resolve) {
                process.nextTick(function () {
                    if (/\.d\.ts$/.test(fileName)) {
                        // if it's already a d.ts file just emit its signature
                        var snapshot = host.getScriptSnapshot(fileName);
                        var signature_1 = crypto.createHash('md5')
                            .update(snapshot.getText(0, snapshot.getLength()))
                            .digest('base64');
                        return resolve({
                            fileName: fileName,
                            signature: signature_1,
                            files: []
                        });
                    }
                    if (hasEmittedSingleFileOutput) {
                        // if we have already emitted the single file output, just emit the
                        // saved signature.
                        return resolve({
                            fileName: fileName,
                            signature: singleFileSignature,
                            files: []
                        });
                    }
                    var input = getVinyl(fileName);
                    var output = service.getEmitOutput(fileName);
                    var files = [];
                    var signature;
                    var javaScriptFile;
                    var declarationFile;
                    var sourceMapFile;
                    if (!input) {
                        throw new Error('No input file found.');
                    }
                    for (var _i = 0, _a = output.outputFiles; _i < _a.length; _i++) {
                        var file_1 = _a[_i];
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
                        var base = (emitToSingleFile ? config.base : input.base) || '.';
                        var relative = path.relative(base, file_1.name);
                        var name_1 = path.resolve(base, relative);
                        var contents = new Buffer(file_1.text);
                        var vinyl = new Vinyl({ path: name_1, base: base, contents: contents });
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
                        var sourceMappingURLPattern = /(\r\n?|\n)?\/\/# sourceMappingURL=[^\r\n]+(?=[\r\n\s]*$)/;
                        var contents = javaScriptFile.contents.toString();
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
                        var capturedSourceFile_1 = sourceMapFile;
                        // adjust the source map to be relative to the source directory.
                        var sourceMap = JSON.parse(sourceMapFile.contents.toString());
                        var sourceRoot_1 = sourceMap.sourceRoot;
                        var sources = emitToSingleFile ? sourceMap.sources : [input.path];
                        var destPath_1 = emitToSingleFile
                            ? path.dirname(path.resolve(config.base, originalCompilerOptions.outFile || originalCompilerOptions.out))
                            : path.resolve(config.base, originalCompilerOptions.outDir || ".");
                        // update sourceRoot
                        sourceRoot_1 = emitSourceMapsInStream ? originalCompilerOptions.sourceRoot : sourceRoot_1;
                        sourceMap.sourceRoot = sourceRoot_1 ? normalize(path.relative(destPath_1, sourceRoot_1)) : undefined;
                        // make all sources absolute
                        sources = sources.map(function (source) { return path.resolve(capturedSourceFile_1.base, source); });
                        if (!javaScriptFile) {
                            throw new Error('Attempted to emit source map without source js file.');
                        }
                        if (emitSourceMapsInStream) {
                            // update sourcesContent
                            if (originalCompilerOptions.inlineSources) {
                                sourceMap.sourcesContent = sources.map(function (source) {
                                    var vinyl = getVinyl(source);
                                    return vinyl
                                        ? vinyl.contents.toString()
                                        : ts.sys.readFile(source);
                                });
                            }
                            // make all sources relative to the sourceRoot or destPath
                            sourceMap.sources = sources.map(function (source) {
                                source = path.resolve(capturedSourceFile_1.base, source);
                                source = path.relative(sourceRoot_1 || destPath_1, source);
                                source = normalize(source);
                                return source;
                            });
                            var newLine = getNewLine();
                            // update the contents for the sourcemap file
                            sourceMapFile.contents = new Buffer(JSON.stringify(sourceMap).replace(/\r?\n/, newLine));
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
                            // sourceContent is handled by gulp-sourcemaps
                            sourceMap.sourcesContent = undefined;
                            // make all sources relative
                            sourceMap.sources = sources.map(function (source) {
                                var vinyl = emitToSingleFile ? getVinyl(source) : input;
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
                        fileName: fileName,
                        signature: signature,
                        files: files
                    });
                });
            });
        }
        var newErrors = Object.create(null);
        var t1 = Date.now();
        var toBeEmitted = [];
        var toBeCheckedSyntactically = [];
        var toBeCheckedSemantically = [];
        var filesWithChangedSignature = [];
        var dependentFiles = [];
        var newLastBuildVersion = new Map();
        var hasEmittedSingleFileOutput = false;
        var singleFileSignature;
        for (var _i = 0, _a = host.getScriptFileNames(); _i < _a.length; _i++) {
            var fileName = _a[_i];
            if (lastBuildVersion[fileName] !== host.getScriptVersion(fileName)) {
                toBeEmitted.push(fileName);
                toBeCheckedSyntactically.push(fileName);
                toBeCheckedSemantically.push(fileName);
            }
        }
        return new PromisePolyfill(function (resolve) {
            var semanticCheckInfo = new Map();
            var seenAsDependentFile = new Set();
            function workOnNext() {
                var promise;
                var fileName;
                // someone told us to stop this
                if (token.isCancellationRequested()) {
                    _log('[CANCEL]', '>>This compile run was cancelled<<');
                    newLastBuildVersion.clear();
                    resolve();
                    return;
                }
                else if (toBeEmitted.length) {
                    fileName = toBeEmitted.pop();
                    var definiteFileName_1 = fileName;
                    promise = emitSoon(definiteFileName_1).then(function (value) {
                        for (var _i = 0, _a = value.files; _i < _a.length; _i++) {
                            var file_2 = _a[_i];
                            _log('[emit code]', file_2.path);
                            out(file_2);
                        }
                        // remember when this was build
                        newLastBuildVersion.set(definiteFileName_1, host.getScriptVersion(definiteFileName_1));
                        // remeber the signature
                        if (value.signature && lastDtsHash[definiteFileName_1] !== value.signature) {
                            lastDtsHash[definiteFileName_1] = value.signature;
                            filesWithChangedSignature.push(definiteFileName_1);
                        }
                    });
                }
                else if (toBeCheckedSyntactically.length) {
                    fileName = toBeCheckedSyntactically.pop();
                    var definiteFileName_2 = fileName;
                    _log('[check syntax]', definiteFileName_2);
                    promise = checkSyntaxSoon(definiteFileName_2).then(function (diagnostics) {
                        delete oldErrors[definiteFileName_2];
                        if (diagnostics.length > 0) {
                            diagnostics.forEach(function (d) { return printDiagnostic(d, onError); });
                            newErrors[definiteFileName_2] = diagnostics;
                            // stop the world when there are syntax errors
                            toBeCheckedSyntactically.length = 0;
                            toBeCheckedSemantically.length = 0;
                            filesWithChangedSignature.length = 0;
                        }
                    });
                }
                else if (toBeCheckedSemantically.length) {
                    fileName = toBeCheckedSemantically.pop();
                    while (fileName && semanticCheckInfo.has(fileName)) {
                        fileName = toBeCheckedSemantically.pop();
                    }
                    if (fileName) {
                        var definiteFileName_3 = fileName;
                        _log('[check semantics]', definiteFileName_3);
                        promise = checkSemanticsSoon(definiteFileName_3).then(function (diagnostics) {
                            delete oldErrors[definiteFileName_3];
                            semanticCheckInfo.set(definiteFileName_3, diagnostics.length);
                            if (diagnostics.length > 0) {
                                diagnostics.forEach(function (d) { return printDiagnostic(d, onError); });
                                newErrors[definiteFileName_3] = diagnostics;
                            }
                        });
                    }
                }
                else if (filesWithChangedSignature.length) {
                    while (filesWithChangedSignature.length) {
                        var fileName_1 = filesWithChangedSignature.pop();
                        if (!isExternalModule(service.getProgram().getSourceFile(fileName_1))) {
                            _log('[check semantics*]', fileName_1 + ' is an internal module and it has changed shape -> check whatever hasn\'t been checked yet');
                            toBeCheckedSemantically.push.apply(toBeCheckedSemantically, host.getScriptFileNames());
                            filesWithChangedSignature.length = 0;
                            dependentFiles.length = 0;
                            break;
                        }
                        host.collectDependents(fileName_1, dependentFiles);
                    }
                }
                else if (dependentFiles.length) {
                    fileName = dependentFiles.pop();
                    while (fileName && seenAsDependentFile.has(fileName)) {
                        fileName = dependentFiles.pop();
                    }
                    if (fileName) {
                        seenAsDependentFile.add(fileName);
                        var value = semanticCheckInfo.get(fileName);
                        if (value === 0) {
                            // already validated successfully -> look at dependents next
                            host.collectDependents(fileName, dependentFiles);
                        }
                        else if (typeof value === 'undefined') {
                            // first validate -> look at dependents next
                            dependentFiles.push(fileName);
                            toBeCheckedSemantically.push(fileName);
                        }
                    }
                }
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
                }).catch(function (err) {
                    console.error(err);
                });
            }
            workOnNext();
        }).then(function () {
            // store the build versions to not rebuilt the next time
            newLastBuildVersion.forEach(function (value, key) {
                lastBuildVersion[key] = value;
            });
            // print old errors and keep them
            utils.collections.forEach(oldErrors, function (entry) {
                entry.value.forEach(function (diag) { return printDiagnostic(diag, onError); });
                newErrors[entry.key] = entry.value;
            });
            oldErrors = newErrors;
            // print stats
            if (config.verbose) {
                var headNow = process.memoryUsage().heapUsed, MB = 1024 * 1024;
                gulp_util_1.log('[tsb]', 'time:', gulp_util_1.colors.yellow((Date.now() - t1) + 'ms'), 'mem:', gulp_util_1.colors.cyan(Math.ceil(headNow / MB) + 'MB'), gulp_util_1.colors.bgCyan('Δ' + Math.ceil((headNow - headUsed) / MB)));
                headUsed = headNow;
            }
        });
    }
    return {
        file: file,
        build: build
    };
}
exports.createTypeScriptBuilder = createTypeScriptBuilder;
var ScriptSnapshot = (function () {
    function ScriptSnapshot(file) {
        this._file = file;
        this._text = file.contents.toString();
        this._mtime = file.stat.mtime;
    }
    ScriptSnapshot.prototype.getVersion = function () {
        return this._mtime.toUTCString();
    };
    ScriptSnapshot.prototype.getText = function (start, end) {
        return this._text.substring(start, end);
    };
    ScriptSnapshot.prototype.getLength = function () {
        return this._text.length;
    };
    ScriptSnapshot.prototype.getChangeRange = function (oldSnapshot) {
        return null;
    };
    ScriptSnapshot.prototype.getFile = function () {
        return this._file;
    };
    ScriptSnapshot.prototype.getBase = function () {
        return this._file.base;
    };
    return ScriptSnapshot;
}());
var LanguageServiceHost = (function () {
    function LanguageServiceHost(settings, config, noFilesystemLookup, typescript) {
        this._typescript = typescript;
        this._settings = settings;
        this._config = config;
        this._noFilesystemLookup = noFilesystemLookup;
        this._snapshots = Object.create(null);
        this._roots = [];
        this._projectVersion = 1;
        this._dependencies = new utils.graph.Graph(function (s) { return s; });
        this._dependenciesRecomputeList = [];
        this._fileNameToDeclaredModule = Object.create(null);
    }
    LanguageServiceHost.prototype.log = function (s) {
        // nothing
    };
    LanguageServiceHost.prototype.trace = function (s) {
        // nothing
    };
    LanguageServiceHost.prototype.error = function (s) {
        console.error(s);
    };
    LanguageServiceHost.prototype.getCompilationSettings = function () {
        return this._settings;
    };
    LanguageServiceHost.prototype.getProjectVersion = function () {
        return String(this._projectVersion);
    };
    LanguageServiceHost.prototype.getNewLine = function () {
        var ts = this._typescript;
        if (this._settings.newLine === ts.NewLineKind.CarriageReturnLineFeed)
            return "\r\n";
        if (this._settings.newLine === ts.NewLineKind.LineFeed)
            return "\n";
        if (ts.sys)
            return ts.sys.newLine;
        return "\r\n";
    };
    LanguageServiceHost.prototype.getScriptFileNames = function () {
        return this._roots.slice(0);
    };
    LanguageServiceHost.prototype.getScriptVersion = function (filename) {
        filename = normalize(filename);
        return this._snapshots[filename].getVersion();
    };
    LanguageServiceHost.prototype.getScriptSnapshot = function (filename) {
        filename = normalize(filename);
        var result = this._snapshots[filename];
        if (!result && !this._noFilesystemLookup) {
            try {
                result = new ScriptSnapshot(new Vinyl({
                    path: filename,
                    contents: fs_1.readFileSync(filename),
                    base: this._config.base,
                    stat: fs_1.statSync(filename)
                }));
                this.addScriptSnapshot(filename, result);
            }
            catch (e) {
            }
        }
        return result;
    };
    LanguageServiceHost.prototype.addScriptSnapshot = function (filename, snapshot, isRoot) {
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
            var match = void 0;
            while ((match = LanguageServiceHost._declareModule.exec(snapshot.getText(0, snapshot.getLength())))) {
                var declaredModules = this._fileNameToDeclaredModule[filename];
                if (!declaredModules) {
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
    };
    LanguageServiceHost.prototype.removeScriptSnapshot = function (filename) {
        this._projectVersion++;
        filename = normalize(filename);
        delete this._fileNameToDeclaredModule[filename];
        var index = this._roots.indexOf(filename);
        if (index >= 0) {
            this._roots.splice(index, 1);
        }
        return delete this._snapshots[filename];
    };
    LanguageServiceHost.prototype.getLocalizedDiagnosticMessages = function () {
        return null;
    };
    LanguageServiceHost.prototype.getCancellationToken = function () {
        return {
            isCancellationRequested: function () { return false; },
            throwIfCancellationRequested: function () {
                // Do nothing.isCancellationRequested is always
                // false so this method never throws
            }
        };
    };
    LanguageServiceHost.prototype.getCurrentDirectory = function () {
        return process.cwd();
    };
    LanguageServiceHost.prototype.getDefaultLibFileName = function (options) {
        var ts = this._typescript;
        var libFile = ts.getDefaultLibFileName(options);
        return normalize(require.resolve("typescript/lib/" + libFile));
    };
    // ---- dependency management
    LanguageServiceHost.prototype.collectDependents = function (filename, target) {
        var file = this._dependenciesRecomputeList.length && this._dependenciesRecomputeList.pop();
        while (file) {
            this._processFile(file);
            file = this._dependenciesRecomputeList.pop();
        }
        filename = normalize(filename);
        var node = this._dependencies.lookup(filename);
        if (node) {
            utils.collections.forEach(node.incoming, function (entry) { return target.push(entry.key); });
        }
    };
    LanguageServiceHost.prototype._processFile = function (filename) {
        var _this = this;
        var ts = this._typescript;
        if (filename.match(/.*\.d\.ts$/)) {
            return;
        }
        filename = normalize(filename);
        var snapshot = this.getScriptSnapshot(filename), info = ts.preProcessFile(snapshot.getText(0, snapshot.getLength()), true);
        // (1) ///-references
        info.referencedFiles.forEach(function (ref) {
            var resolvedPath = path.resolve(path.dirname(filename), ref.fileName), normalizedPath = normalize(resolvedPath);
            _this._dependencies.inertEdge(filename, normalizedPath);
        });
        // (2) import-require statements
        info.importedFiles.forEach(function (ref) {
            var stopDirname = normalize(_this.getCurrentDirectory()), dirname = filename, found = false;
            while (!found && dirname.indexOf(stopDirname) === 0) {
                dirname = path.dirname(dirname);
                var resolvedPath = path.resolve(dirname, ref.fileName), normalizedPath = normalize(resolvedPath);
                if (_this.getScriptSnapshot(normalizedPath + '.ts')) {
                    _this._dependencies.inertEdge(filename, normalizedPath + '.ts');
                    found = true;
                }
                else if (_this.getScriptSnapshot(normalizedPath + '.d.ts')) {
                    _this._dependencies.inertEdge(filename, normalizedPath + '.d.ts');
                    found = true;
                }
            }
            if (!found) {
                for (var key in _this._fileNameToDeclaredModule) {
                    if (_this._fileNameToDeclaredModule[key] && ~_this._fileNameToDeclaredModule[key].indexOf(ref.fileName)) {
                        _this._dependencies.inertEdge(filename, key);
                    }
                }
            }
        });
    };
    return LanguageServiceHost;
}());
LanguageServiceHost._declareModule = /declare\s+module\s+('|")(.+)\1/g;
//# sourceMappingURL=builder.js.map
