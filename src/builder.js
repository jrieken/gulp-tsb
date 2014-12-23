/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/vinyl/vinyl.d.ts" />
/// <reference path="../typings/gulp-util/gulp-util.d.ts" />
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var utils = require('./utils');
var gutil = require('gulp-util');
var ts = require('./typescript/typescriptServices');
var Vinyl = require('vinyl');
function createTypeScriptBuilder(config) {
    var settings = createCompilationSettings(config), host = new LanguageServiceHost(settings), service = ts.createLanguageService(host, ts.createDocumentRegistry()), lastBuildVersion = Object.create(null), lastDtsHash = Object.create(null), userWantsDeclarations = settings.declaration, oldErrors = Object.create(null), headUsed = process.memoryUsage().heapUsed;
    // always emit declaraction files
    host.getCompilationSettings().declaration = true;
    if (!host.getCompilationSettings().noLib) {
        var defaultLib = host.getDefaultLibFilename();
        host.addScriptSnapshot(defaultLib, new ScriptSnapshot(fs.readFileSync(defaultLib), fs.statSync(defaultLib)));
    }
    function log(topic, message) {
        if (config.verbose) {
            gutil.log(gutil.colors.cyan(topic), message);
        }
    }
    function printDiagnostic(diag, onError) {
        var lineAndCh = diag.file.getLineAndCharacterFromPosition(diag.start), message;
        if (!config.json) {
            message = utils.strings.format('{0}({1},{2}): {3}', diag.file.filename, lineAndCh.line, lineAndCh.character, diag.messageText);
        }
        else {
            message = JSON.stringify({
                filename: diag.file.filename,
                offset: diag.start,
                length: diag.length,
                message: diag.messageText
            });
        }
        onError(message);
    }
    function file(file) {
        var snapshot = new ScriptSnapshot(file.contents, file.stat);
        host.addScriptSnapshot(file.path, snapshot);
    }
    function build(out, onError) {
        var filenames = host.getScriptFileNames(), newErrors = Object.create(null), checkedThisRound = Object.create(null), filesWithShapeChanges = [], t1 = Date.now();
        function shouldCheck(filename) {
            if (checkedThisRound[filename]) {
                return false;
            }
            else {
                checkedThisRound[filename] = true;
                return true;
            }
        }
        for (var i = 0, len = filenames.length; i < len; i++) {
            var filename = filenames[i], version = host.getScriptVersion(filename);
            if (lastBuildVersion[filename] === version) {
                continue;
            }
            var output = service.getEmitOutput(filename), checkSyntax = false, checkSemantics = false, dtsHash = undefined;
            // emit output has fast as possible
            output.outputFiles.forEach(function (file) {
                if (/\.d\.ts$/.test(file.name)) {
                    dtsHash = crypto.createHash('md5').update(file.text).digest('base64');
                    if (!userWantsDeclarations) {
                        // don't leak .d.ts files if users don't want them
                        return;
                    }
                }
                log('[emit output]', file.name);
                out(new Vinyl({
                    path: file.name,
                    contents: new Buffer(file.text)
                }));
            });
            switch (output.emitOutputStatus) {
                case ts.EmitReturnStatus.Succeeded:
                    break;
                case ts.EmitReturnStatus.AllOutputGenerationSkipped:
                    log('[syntax errors]', filename);
                    checkSyntax = true;
                    break;
                case ts.EmitReturnStatus.JSGeneratedWithSemanticErrors:
                case ts.EmitReturnStatus.DeclarationGenerationSkipped:
                    log('[semantic errors]', filename);
                    checkSemantics = true;
                    break;
                case ts.EmitReturnStatus.EmitErrorsEncountered:
                case ts.EmitReturnStatus.CompilerOptionsErrors:
                default:
                    // don't really know what to do with these
                    checkSyntax = true;
                    checkSemantics = true;
                    break;
            }
            // print and store syntax and semantic errors
            delete oldErrors[filename];
            var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []);
            if (checkSyntax) {
                diagnostics.push.apply(diagnostics, service.getSyntacticDiagnostics(filename));
            }
            if (checkSemantics) {
                diagnostics.push.apply(diagnostics, service.getSemanticDiagnostics(filename));
            }
            diagnostics.forEach(function (diag) {
                printDiagnostic(diag, onError);
            });
            // dts comparing
            if (dtsHash && lastDtsHash[filename] !== dtsHash) {
                lastDtsHash[filename] = dtsHash;
                if (service.getSourceFile(filename).externalModuleIndicator) {
                    filesWithShapeChanges.push(filename);
                }
                else {
                    filesWithShapeChanges.unshift(filename);
                }
            }
            lastBuildVersion[filename] = version;
            checkedThisRound[filename] = true;
        }
        if (filesWithShapeChanges.length === 0) {
        }
        else if (!service.getSourceFile(filesWithShapeChanges[0]).externalModuleIndicator) {
            // at least one internal module changes which means that
            // we have to type check all others
            log('[shape changes]', 'internal module changed → FULL check required');
            host.getScriptFileNames().forEach(function (filename) {
                if (!shouldCheck(filename)) {
                    return;
                }
                log('[semantic check*]', filename);
                var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []);
                service.getSemanticDiagnostics(filename).forEach(function (diag) {
                    diagnostics.push(diag);
                    printDiagnostic(diag, onError);
                });
            });
        }
        else {
            // reverse dependencies
            log('[shape changes]', 'external module changed → check REVERSE dependencies');
            var needsSemanticCheck = [];
            filesWithShapeChanges.forEach(function (filename) { return host.collectDependents(filename, needsSemanticCheck); });
            while (needsSemanticCheck.length) {
                var filename = needsSemanticCheck.pop();
                if (!shouldCheck(filename)) {
                    continue;
                }
                log('[semantic check*]', filename);
                var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []), hasSemanticErrors = false;
                service.getSemanticDiagnostics(filename).forEach(function (diag) {
                    diagnostics.push(diag);
                    printDiagnostic(diag, onError);
                    hasSemanticErrors = true;
                });
                if (!hasSemanticErrors) {
                    host.collectDependents(filename, needsSemanticCheck);
                }
            }
        }
        // (4) dump old errors
        utils.collections.forEach(oldErrors, function (entry) {
            entry.value.forEach(function (diag) { return printDiagnostic(diag, onError); });
            newErrors[entry.key] = entry.value;
        });
        oldErrors = newErrors;
        if (config.verbose) {
            var headNow = process.memoryUsage().heapUsed, MB = 1024 * 1024;
            gutil.log('[tsb]', 'time:', gutil.colors.yellow((Date.now() - t1) + 'ms'), 'mem:', gutil.colors.cyan(Math.ceil(headNow / MB) + 'MB'), gutil.colors.bgCyan('Δ' + Math.ceil((headNow - headUsed) / MB)));
            headUsed = headNow;
        }
    }
    return {
        file: file,
        build: build
    };
}
exports.createTypeScriptBuilder = createTypeScriptBuilder;
function createCompilationSettings(config) {
    // language version
    if (!config['target']) {
        config['target'] = ts.ScriptTarget.ES3;
    }
    else if (/ES3/i.test(String(config['target']))) {
        config['target'] = ts.ScriptTarget.ES3;
    }
    else if (/ES5/i.test(String(config['target']))) {
        config['target'] = ts.ScriptTarget.ES5;
    }
    else if (/ES6/i.test(String(config['target']))) {
        config['target'] = ts.ScriptTarget.ES6;
    }
    // module generation
    if (/commonjs/i.test(String(config['module']))) {
        config['module'] = ts.ModuleKind.CommonJS;
    }
    else if (/amd/i.test(String(config['module']))) {
        config['module'] = ts.ModuleKind.AMD;
    }
    return config;
}
var ScriptSnapshot = (function () {
    function ScriptSnapshot(buffer, stat) {
        this._text = buffer.toString();
        this._lineStarts = ts.computeLineStarts(this._text);
        this._mtime = stat.mtime;
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
    ScriptSnapshot.prototype.getLineStartPositions = function () {
        return this._lineStarts;
    };
    ScriptSnapshot.prototype.getChangeRange = function (oldSnapshot) {
        return null;
    };
    return ScriptSnapshot;
})();
var LanguageServiceHost = (function () {
    function LanguageServiceHost(settings) {
        this._settings = settings;
        this._snapshots = Object.create(null);
        this._defaultLib = path.normalize(path.join(__dirname, 'typescript', 'lib.d.ts'));
        this._dependencies = new utils.graph.Graph(function (s) { return s; });
        this._dependenciesRecomputeList = [];
    }
    LanguageServiceHost.prototype.log = function (s) {
        // nothing
    };
    LanguageServiceHost.prototype.getCompilationSettings = function () {
        return this._settings;
    };
    LanguageServiceHost.prototype.getScriptFileNames = function () {
        return Object.keys(this._snapshots);
    };
    LanguageServiceHost.prototype.getScriptVersion = function (filename) {
        filename = path.normalize(filename);
        return this._snapshots[filename].getVersion();
    };
    LanguageServiceHost.prototype.getScriptIsOpen = function (filename) {
        return false;
    };
    LanguageServiceHost.prototype.getScriptSnapshot = function (filename) {
        filename = path.normalize(filename);
        return this._snapshots[filename];
    };
    LanguageServiceHost.prototype.addScriptSnapshot = function (filename, snapshot) {
        filename = path.normalize(filename);
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
    };
    LanguageServiceHost.prototype.getLocalizedDiagnosticMessages = function () {
        return null;
    };
    LanguageServiceHost.prototype.getCancellationToken = function () {
        return { isCancellationRequested: function () { return false; } };
    };
    LanguageServiceHost.prototype.getCurrentDirectory = function () {
        return process.cwd();
    };
    LanguageServiceHost.prototype.getDefaultLibFilename = function () {
        return this._defaultLib;
    };
    // ---- dependency management 
    LanguageServiceHost.prototype.collectDependents = function (filename, target) {
        while (this._dependenciesRecomputeList.length) {
            this._processFile(this._dependenciesRecomputeList.pop());
        }
        filename = path.normalize(filename);
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
        filename = path.normalize(filename);
        var snapshot = this.getScriptSnapshot(filename), info = ts.preProcessFile(snapshot.getText(0, snapshot.getLength()), true);
        // (1) ///-references
        info.referencedFiles.forEach(function (ref) {
            var resolvedPath = path.resolve(path.dirname(filename), ref.filename), normalizedPath = path.normalize(resolvedPath);
            _this._dependencies.inertEdge(filename, normalizedPath);
        });
        // (2) import-require statements
        info.importedFiles.forEach(function (ref) {
            var stopDirname = path.normalize(_this.getCurrentDirectory()), dirname = filename, found = false;
            while (!found && dirname.indexOf(stopDirname) === 0) {
                dirname = path.dirname(dirname);
                var resolvedPath = path.resolve(dirname, ref.filename), normalizedPath = path.normalize(resolvedPath);
                if (_this.getScriptSnapshot(normalizedPath + '.ts')) {
                    _this._dependencies.inertEdge(filename, normalizedPath + '.ts');
                    found = true;
                }
                else if (_this.getScriptSnapshot(normalizedPath + '.d.ts')) {
                    _this._dependencies.inertEdge(filename, normalizedPath + '.d.ts');
                    found = true;
                }
            }
        });
    };
    return LanguageServiceHost;
})();
