/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/vinyl/vinyl.d.ts" />
/// <reference path="../typings/gulp-util/gulp-util.d.ts" />
'use strict';
var fs = require('fs');
var vinyl = require('vinyl');
var path = require('path');
var utils = require('./utils');
var gutil = require('gulp-util');
var typescript = require('./typescript/typescriptServices');
var ts = typescript.ts;
function createTypeScriptBuilder(config) {
    var host = new LanguageServiceHost(createCompilationSettings(config)), languageService = ts.createLanguageService(host, ts.createDocumentRegistry()), oldErrors = Object.create(null);
    function createCompilationSettings(config) {
        var result = {
            noLib: config.noLib,
            removeComments: config.removeComments,
            declaration: config.declaration,
            noImplicitAny: config.noImplicitAny,
            target: 1 /* ES5 */,
            module: 0 /* None */
        };
        // language version
        if (config.target && config.target.toLowerCase() === 'es5') {
            result.target = 1 /* ES5 */;
        }
        // module generation
        if (config.module) {
            switch (config.module.toLowerCase()) {
                case 'commonjs':
                    result.module = 1 /* CommonJS */;
                    break;
                case 'amd':
                    result.module = 2 /* AMD */;
                    break;
            }
        }
        return result;
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
    if (!host.getCompilationSettings().noLib) {
        var defaultLib = host.getDefaultLibFilename();
        host.addScriptSnapshot(defaultLib, new ScriptSnapshot(fs.readFileSync(defaultLib), fs.statSync(defaultLib)));
    }
    return {
        build: function (out, onError) {
            var task = host.createSnapshotAndAdviseValidation(), newErrors = Object.create(null), t1 = Date.now();
            if (config.verbose) {
                gutil.log(gutil.colors.cyan(task.changed.length.toString()), 'files that need a syntax check and be emitted\n\t' + gutil.colors.magenta(task.changed.join('\n\t')));
                gutil.log(gutil.colors.cyan(task.changedOrDependencyChanged.length.toString()), 'files that need a semantic check\n\t' + gutil.colors.magenta(task.changedOrDependencyChanged.join('\n\t')));
            }
            // (1) check for syntax errors
            task.changed.forEach(function (fileName) {
                delete oldErrors[fileName];
                languageService.getSyntacticDiagnostics(fileName).forEach(function (diag) {
                    printDiagnostic(diag, onError);
                    utils.collections.lookupOrInsert(newErrors, fileName, []).push(diag);
                });
            });
            // (2) emit
            task.changed.forEach(function (fileName) {
                var output = languageService.getEmitOutput(fileName);
                output.outputFiles.forEach(function (file) {
                    out(new vinyl({
                        path: file.name,
                        contents: new Buffer(file.text)
                    }));
                });
            });
            // (3) semantic check
            task.changedOrDependencyChanged.forEach(function (fileName) {
                delete oldErrors[fileName];
                languageService.getSemanticDiagnostics(fileName).forEach(function (diag) {
                    printDiagnostic(diag, onError);
                    utils.collections.lookupOrInsert(newErrors, fileName, []).push(diag);
                });
            });
            // (4) dump old errors
            utils.collections.forEach(oldErrors, function (entry) {
                entry.value.forEach(function (diag) { return printDiagnostic(diag, onError); });
            });
            oldErrors = newErrors;
            if (config.verbose) {
                gutil.log('Finished after', gutil.colors.yellow((Date.now() - t1) + 'ms'));
            }
        },
        file: function (file) {
            var snapshot = new ScriptSnapshot(file.contents, file.stat);
            host.addScriptSnapshot(file.path, snapshot);
        }
    };
}
exports.createTypeScriptBuilder = createTypeScriptBuilder;
var ScriptSnapshot = (function () {
    function ScriptSnapshot(buffer, stat) {
        this._text = buffer.toString();
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
        return typescript.TypeScript.TextUtilities.parseLineStarts(this._text);
    };
    ScriptSnapshot.prototype.getChangeRange = function (oldSnapshot) {
        return null;
    };
    return ScriptSnapshot;
})();
var ProjectSnapshot = (function () {
    function ProjectSnapshot(host) {
        this._captureState(host);
    }
    ProjectSnapshot.prototype._captureState = function (host) {
        var _this = this;
        this._dependencies = new utils.graph.Graph(function (s) { return s; });
        this._versions = Object.create(null);
        host.getScriptFileNames().forEach(function (fileName) {
            fileName = ts.normalizePath(fileName);
            // (1) paths and versions
            _this._versions[fileName] = host.getScriptVersion(fileName);
            // (2) dependency graph for *.ts files
            if (!fileName.match(/.*\.d\.ts$/)) {
                var snapshot = host.getScriptSnapshot(fileName), info = typescript.TypeScript.preProcessFile(fileName, snapshot, true);
                info.referencedFiles.forEach(function (ref) {
                    var resolvedPath = path.resolve(path.dirname(fileName), ref.path), normalizedPath = ts.normalizePath(resolvedPath);
                    _this._dependencies.inertEdge(fileName, normalizedPath);
                    //					console.log(fileName + ' -> ' + normalizedPath);
                });
                info.importedFiles.forEach(function (ref) {
                    var stopDirname = ts.normalizePath(host.getCurrentDirectory()), dirname = fileName;
                    while (dirname.indexOf(stopDirname) === 0) {
                        dirname = path.dirname(dirname);
                        var resolvedPath = path.resolve(dirname, ref.path), normalizedPath = ts.normalizePath(resolvedPath);
                        // try .ts
                        if (['.ts', '.d.ts'].some(function (suffix) {
                            var candidate = normalizedPath + suffix;
                            if (host.getScriptSnapshot(candidate)) {
                                _this._dependencies.inertEdge(fileName, candidate);
                                //							console.log(fileName + ' -> ' + candidate);
                                return true;
                            }
                            return false;
                        })) {
                            break;
                        }
                        ;
                    }
                });
            }
        });
    };
    ProjectSnapshot.prototype.whatToValidate = function (host) {
        var _this = this;
        var changed = [], added = [], removed = [];
        // compile file delta (changed, added, removed)
        var idx = Object.create(null);
        host.getScriptFileNames().forEach(function (fileName) { return idx[fileName] = host.getScriptVersion(fileName); });
        utils.collections.forEach(this._versions, function (entry) {
            var versionNow = idx[entry.key];
            if (typeof versionNow === 'undefined') {
                // removed
                removed.push(entry.key);
            }
            else if (typeof versionNow === 'string' && versionNow !== entry.value) {
                // changed
                changed.push(entry.key);
            }
            delete idx[entry.key];
        });
        // cos we removed all we saw earlier
        added = Object.keys(idx);
        // what to validate?
        var syntax = changed.concat(added), semantic = [];
        if (removed.length > 0 || added.length > 0) {
            semantic = host.getScriptFileNames();
        }
        else {
            // validate every change file *plus* the files
            // that depend on the changed file 
            changed.forEach(function (fileName) { return _this._dependencies.traverse(fileName, false, function (data) { return semantic.push(data); }); });
        }
        return {
            changed: syntax,
            changedOrDependencyChanged: semantic
        };
    };
    return ProjectSnapshot;
})();
var LanguageServiceHost = (function () {
    function LanguageServiceHost(settings) {
        this._settings = settings;
        this._snapshots = Object.create(null);
        this._defaultLib = ts.normalizePath(path.join(__dirname, 'typescript', 'lib.d.ts'));
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
    LanguageServiceHost.prototype.getScriptVersion = function (fileName) {
        fileName = ts.normalizePath(fileName);
        return this._snapshots[fileName].getVersion();
    };
    LanguageServiceHost.prototype.getScriptIsOpen = function (fileName) {
        return false;
    };
    LanguageServiceHost.prototype.getScriptSnapshot = function (fileName) {
        fileName = ts.normalizePath(fileName);
        return this._snapshots[fileName];
    };
    LanguageServiceHost.prototype.addScriptSnapshot = function (fileName, snapshot) {
        fileName = ts.normalizePath(fileName);
        var old = this._snapshots[fileName];
        this._snapshots[fileName] = snapshot;
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
    LanguageServiceHost.prototype.createSnapshotAndAdviseValidation = function () {
        var ret;
        if (!this._projectSnapshot) {
            ret = {
                changed: this.getScriptFileNames(),
                changedOrDependencyChanged: this.getScriptFileNames()
            };
        }
        else {
            ret = this._projectSnapshot.whatToValidate(this);
        }
        this._projectSnapshot = new ProjectSnapshot(this);
        return ret;
    };
    return LanguageServiceHost;
})();
