'use strict';
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var fs_1 = require('fs');
var path = require('path');
var crypto = require('crypto');
var utils = require('./utils');
var gulp_util_1 = require('gulp-util');
var ts = require('./typescript/typescriptServices');
var Vinyl = require('vinyl');
var CancellationToken;
(function (CancellationToken) {
    CancellationToken.None = {
        isCancellationRequested: function () { return false; }
    };
})(CancellationToken = exports.CancellationToken || (exports.CancellationToken = {}));
function normalize(path) {
    return path.replace(/\\/g, '/');
}
function createTypeScriptBuilder(config) {
    var compilerOptions = createCompilerOptions(config), host = new LanguageServiceHost(compilerOptions), service = ts.createLanguageService(host, ts.createDocumentRegistry()), lastBuildVersion = Object.create(null), lastDtsHash = Object.create(null), userWantsDeclarations = compilerOptions.declaration, oldErrors = Object.create(null), headUsed = process.memoryUsage().heapUsed, emitSourceMapsInStream = true;
    // always emit declaraction files
    host.getCompilationSettings().declaration = true;
    if (!host.getCompilationSettings().noLib) {
        var defaultLib = host.getDefaultLibFileName();
        host.addScriptSnapshot(defaultLib, new DefaultLibScriptSnapshot(defaultLib));
    }
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
        if (file.sourceMap) {
            emitSourceMapsInStream = false;
        }
        if (!file.contents) {
            host.removeScriptSnapshot(file.path);
        }
        else {
            host.addScriptSnapshot(file.path, new VinylScriptSnapshot(file));
        }
    }
    function baseFor(snapshot) {
        if (snapshot instanceof VinylScriptSnapshot) {
            return compilerOptions.outDir || snapshot.getBase();
        }
        else {
            return '';
        }
    }
    function isExternalModule(sourceFile) {
        return sourceFile.externalModuleIndicator
            || /declare\s+module\s+('|")(.+)\1/.test(sourceFile.getText());
    }
    function build(out, onError, token) {
        if (token === void 0) { token = CancellationToken.None; }
        function checkSyntaxSoon(fileName) {
            return new Promise(function (resolve) {
                setTimeout(function () {
                    resolve(service.getSyntacticDiagnostics(fileName));
                }, 0);
            });
        }
        function checkSemanticsSoon(fileName) {
            return new Promise(function (resolve) {
                setTimeout(function () {
                    resolve(service.getSemanticDiagnostics(fileName));
                }, 0);
            });
        }
        function emitSoon(fileName) {
            return new Promise(function (resolve) {
                setTimeout(function () {
                    if (/\.d\.ts$/.test(fileName)) {
                        // if it's already a d.ts file just emit it signature
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
                    var output = service.getEmitOutput(fileName);
                    var files = [];
                    var signature;
                    for (var _i = 0, _a = output.outputFiles; _i < _a.length; _i++) {
                        var file_1 = _a[_i];
                        if (!emitSourceMapsInStream && /\.js\.map$/.test(file_1.name)) {
                            continue;
                        }
                        if (/\.d\.ts$/.test(file_1.name)) {
                            signature = crypto.createHash('md5')
                                .update(file_1.text)
                                .digest('base64');
                            if (!userWantsDeclarations) {
                                // don't leak .d.ts files if users don't want them
                                continue;
                            }
                        }
                        var vinyl = new Vinyl({
                            path: file_1.name,
                            contents: new Buffer(file_1.text),
                            base: !config._emitWithoutBasePath && baseFor(host.getScriptSnapshot(fileName))
                        });
                        if (!emitSourceMapsInStream && /\.js$/.test(file_1.name)) {
                            var sourcemapFile = output.outputFiles.filter(function (f) { return /\.js\.map$/.test(f.name); })[0];
                            if (sourcemapFile) {
                                var extname = path.extname(vinyl.relative);
                                var basename = path.basename(vinyl.relative, extname);
                                var dirname = path.dirname(vinyl.relative);
                                var tsname = (dirname === '.' ? '' : dirname + '/') + basename + '.ts';
                                var sourceMap = JSON.parse(sourcemapFile.text);
                                sourceMap.sources[0] = tsname.replace(/\\/g, '/');
                                vinyl.sourceMap = sourceMap;
                            }
                        }
                        files.push(vinyl);
                    }
                    resolve({
                        fileName: fileName,
                        signature: signature,
                        files: files
                    });
                }, 0);
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
        for (var _i = 0, _a = host.getScriptFileNames(); _i < _a.length; _i++) {
            var fileName = _a[_i];
            if (lastBuildVersion[fileName] !== host.getScriptVersion(fileName)) {
                toBeEmitted.push(fileName);
                toBeCheckedSyntactically.push(fileName);
                toBeCheckedSemantically.push(fileName);
            }
        }
        return new Promise(function (resolve) {
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
                    promise = emitSoon(fileName).then(function (value) {
                        for (var _i = 0, _a = value.files; _i < _a.length; _i++) {
                            var file_2 = _a[_i];
                            _log('[emit code]', file_2.path);
                            out(file_2);
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
                else if (toBeCheckedSyntactically.length) {
                    fileName = toBeCheckedSyntactically.pop();
                    _log('[check syntax]', fileName);
                    promise = checkSyntaxSoon(fileName).then(function (diagnostics) {
                        delete oldErrors[fileName];
                        if (diagnostics.length > 0) {
                            diagnostics.forEach(function (d) { return printDiagnostic(d, onError); });
                            newErrors[fileName] = diagnostics;
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
                        _log('[check semantics]', fileName);
                        promise = checkSemanticsSoon(fileName).then(function (diagnostics) {
                            delete oldErrors[fileName];
                            semanticCheckInfo.set(fileName, diagnostics.length);
                            if (diagnostics.length > 0) {
                                diagnostics.forEach(function (d) { return printDiagnostic(d, onError); });
                                newErrors[fileName] = diagnostics;
                            }
                        });
                    }
                }
                else if (filesWithChangedSignature.length) {
                    while (filesWithChangedSignature.length) {
                        var fileName_1 = filesWithChangedSignature.pop();
                        if (!isExternalModule(service.getSourceFile(fileName_1))) {
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
                    promise = Promise.resolve();
                }
                promise.then(function () {
                    // change to change
                    setTimeout(workOnNext, 0);
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
function createCompilerOptions(config) {
    // language version
    if (!config['target']) {
        config['target'] = 0 /* ES3 */;
    }
    else if (/ES3/i.test(String(config['target']))) {
        config['target'] = 0 /* ES3 */;
    }
    else if (/ES5/i.test(String(config['target']))) {
        config['target'] = 1 /* ES5 */;
    }
    else if (/ES6/i.test(String(config['target']))) {
        config['target'] = 2 /* ES6 */;
    }
    // module generation
    if (/commonjs/i.test(String(config['module']))) {
        config['module'] = 1 /* CommonJS */;
    }
    else if (/amd/i.test(String(config['module']))) {
        config['module'] = 2 /* AMD */;
    }
    // jsx handling
    if (/none/i.test(String(config['jsx']))) {
        config['jsx'] = 0 /* None */;
    }
    else if (/preserve/i.test(String(config['jsx']))) {
        config['jsx'] = 1 /* Preserve */;
    }
    else if (/react/i.test(String(config['jsx']))) {
        config['jsx'] = 2 /* React */;
    }
    return config;
}
var ScriptSnapshot = (function () {
    function ScriptSnapshot(text, mtime) {
        this._text = text;
        this._mtime = mtime;
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
    return ScriptSnapshot;
})();
var DefaultLibScriptSnapshot = (function (_super) {
    __extends(DefaultLibScriptSnapshot, _super);
    function DefaultLibScriptSnapshot(defaultLib) {
        _super.call(this, fs_1.readFileSync(defaultLib).toString(), fs_1.statSync(defaultLib).mtime);
    }
    return DefaultLibScriptSnapshot;
})(ScriptSnapshot);
var VinylScriptSnapshot = (function (_super) {
    __extends(VinylScriptSnapshot, _super);
    function VinylScriptSnapshot(file) {
        _super.call(this, file.contents.toString(), file.stat.mtime);
        this._base = file.base;
    }
    VinylScriptSnapshot.prototype.getBase = function () {
        return this._base;
    };
    return VinylScriptSnapshot;
})(ScriptSnapshot);
var LanguageServiceHost = (function () {
    function LanguageServiceHost(settings) {
        this._settings = settings;
        this._snapshots = Object.create(null);
        this._defaultLib = normalize(path.join(__dirname, 'typescript', settings.target === 2 /* ES6 */
            ? 'lib.es6.d.ts'
            : 'lib.d.ts'));
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
    LanguageServiceHost.prototype.getScriptFileNames = function () {
        return Object.keys(this._snapshots).filter(function (filename) { return /\.tsx?/i.test(path.extname(filename)); });
    };
    LanguageServiceHost.prototype.getScriptVersion = function (filename) {
        filename = normalize(filename);
        return this._snapshots[filename].getVersion();
    };
    LanguageServiceHost.prototype.getScriptSnapshot = function (filename) {
        filename = normalize(filename);
        var result = this._snapshots[filename];
        if (!result) {
            try {
                result = new VinylScriptSnapshot(new Vinyl({
                    path: filename,
                    contents: fs_1.readFileSync(filename),
                    base: this._settings.outDir,
                    stat: fs_1.statSync(filename)
                }));
                this.addScriptSnapshot(filename, result);
            }
            catch (e) {
            }
        }
        return result;
    };
    LanguageServiceHost.prototype.addScriptSnapshot = function (filename, snapshot) {
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
            var match;
            while ((match = LanguageServiceHost._declareModule.exec(snapshot.getText(0, snapshot.getLength())))) {
                var declaredModules = this._fileNameToDeclaredModule[filename];
                if (!declaredModules) {
                    this._fileNameToDeclaredModule[filename] = declaredModules = [];
                }
                declaredModules.push(match[2]);
            }
        }
        this._snapshots[filename] = snapshot;
        return old;
    };
    LanguageServiceHost.prototype.removeScriptSnapshot = function (filename) {
        filename = normalize(filename);
        delete this._fileNameToDeclaredModule[filename];
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
    LanguageServiceHost.prototype.getDefaultLibFileName = function () {
        return this._defaultLib;
    };
    // ---- dependency management
    LanguageServiceHost.prototype.collectDependents = function (filename, target) {
        while (this._dependenciesRecomputeList.length) {
            this._processFile(this._dependenciesRecomputeList.pop());
        }
        filename = normalize(filename);
        var node = this._dependencies.lookup(filename);
        if (node) {
            utils.collections.forEach(node.incoming, function (entry) { return target.push(entry.key); });
        }
    };
    LanguageServiceHost.prototype._processFile = function (filename) {
        var _this = this;
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
    LanguageServiceHost._declareModule = /declare\s+module\s+('|")(.+)\1/g;
    return LanguageServiceHost;
})();
