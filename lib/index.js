'use strict';
var vinylfs = require("vinyl-fs");
var gutil = require("gulp-util");
var through = require("through");
var builder_1 = require("./builder");
var fs_1 = require("fs");
var path_1 = require("path");
var utils_1 = require("./utils");
var child_process_1 = require("child_process");
var assign = Object.assign || require('es6-object-assign').assign;
var IncrementalCompiler = (function () {
    function IncrementalCompiler() {
        throw new Error("Not implemented");
    }
    Object.defineProperty(IncrementalCompiler.prototype, "compilerOptions", {
        /** Gets the current compiler options. */
        get: function () {
            return this._options || (this._options = this._parseOptions(/*includeFiles*/ false).options);
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(IncrementalCompiler.prototype, "fileNames", {
        /** Gets the current file names. */
        get: function () {
            if (!this._project) {
                return [];
            }
            // we do not cache file names between calls to .src() to allow new files to be picked up by
            // the compiler between compilations.  However, we will cache the compiler options if we
            // haven't seen them yet.
            var parsed = this._parseOptions(/*includeFiles*/ true);
            if (!this._options) {
                this._options = parsed.options;
            }
            return parsed.fileNames;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(IncrementalCompiler.prototype, "globs", {
        /** Gets glob patterns used to match files in the project. */
        get: function () {
            if (!this._project) {
                return [];
            }
            if (this._globs) {
                return this._globs;
            }
            var globs = [];
            var relativedir = path_1.relative(process.cwd(), this._config.base || '.');
            if (this._json.include) {
                for (var _i = 0, _a = this._json.include; _i < _a.length; _i++) {
                    var include = _a[_i];
                    globs.push(path_1.isAbsolute(include) ? include : path_1.join(relativedir, include));
                }
            }
            else if (!this._json.files) {
                globs.push(path_1.join(relativedir, "**/*"));
            }
            if (this._json.exclude) {
                for (var _b = 0, _c = this._json.exclude; _b < _c.length; _b++) {
                    var exclude = _c[_b];
                    globs.push("!" + (path_1.isAbsolute(exclude) ? exclude : path_1.join(relativedir, exclude)));
                }
            }
            else {
                globs.push("!" + path_1.join(relativedir, "node_modules/**/*"), "!" + path_1.join(relativedir, "bower_components/**/*"), "!" + path_1.join(relativedir, "jspm_packages/**/*"));
            }
            return this._globs = globs;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(IncrementalCompiler.prototype, "destPath", {
        /** Gets the expected destination path. */
        get: function () {
            var destPath = this._config.base || '.';
            var compilerOptions = this.compilerOptions;
            var outFile = compilerOptions.outFile || compilerOptions.out;
            if (compilerOptions.outDir) {
                destPath = path_1.resolve(destPath, compilerOptions.outDir);
            }
            else if (outFile) {
                destPath = path_1.dirname(path_1.resolve(destPath, outFile));
            }
            return path_1.relative(process.cwd(), destPath);
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(IncrementalCompiler.prototype, "sourcemapPath", {
        /** Gets the expected sourcemap path (for use with gulp-sourcemaps). */
        get: function () {
            return this.compilerOptions.inlineSourceMap ? undefined : ".";
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(IncrementalCompiler.prototype, "sourcemapOptions", {
        /** Gets the sourcemap options (for use with gulp-sourcemaps). */
        get: function () {
            return {
                includeContent: this.compilerOptions.inlineSources,
                destPath: this.destPath
            };
        },
        enumerable: true,
        configurable: true
    });
    IncrementalCompiler.prototype._createBuilderProxy = function () {
        var child = child_process_1.fork(path_1.join(__dirname, './index.js'));
        var outputCb = function () { };
        var errorCb = function () { };
        var completionPromise;
        var resolveFunction = function () { };
        var rejectFunction = function () { };
        child.on('message', function (data) {
            switch (data.kind) {
                case 'end-of-output':
                    resolveFunction(data.value); // Signal end of stream
                    child.unref(); // Unref the child so the parent process can die (and then let the child die)
                    break;
                case 'output':
                    outputCb(utils_1.deserializeVinyl(data.file));
                    break;
                case 'error':
                    errorCb(data.message);
                    break;
            }
        });
        child.send({ kind: 'config', config: this._config, compilerOptions: this.compilerOptions });
        return {
            build: function (outcb, errcb) {
                child.ref(); // We have to keep the ref until the build is done if we're unreffed
                outputCb = outcb;
                errorCb = errcb;
                completionPromise = new Promise(function (resolve, reject) {
                    resolveFunction = resolve;
                    rejectFunction = reject;
                });
                child.send({ kind: 'build' });
                return completionPromise;
            },
            file: function (file) {
                child.send({ kind: 'file', file: utils_1.serializeVinyl(file) });
            }
        };
    };
    Object.defineProperty(IncrementalCompiler.prototype, "builder", {
        get: function () {
            return this._builder || (this._builder = this._config.parallel ? this._createBuilderProxy() : builder_1.createTypeScriptBuilder(this._config, Object.assign({}, this.compilerOptions)));
        },
        enumerable: true,
        configurable: true
    });
    /**
     * Create an IncrementalCompiler from a tsconfig.json file.
     *
     * @param project The path to a tsconfig.json file or its parent directory.
     * @param config Configuration settings.
     * @param onError A custom error handler.
     */
    IncrementalCompiler.fromProject = function (project, config, onError) {
        var possibleProject = path_1.resolve(project, "tsconfig.json");
        if (fs_1.existsSync(possibleProject)) {
            project = possibleProject;
        }
        return this._fromProjectAndOptions(project, /*options*/ undefined, config, onError);
    };
    /**
     * Create an IncrementalCompiler from a set of options.
     *
     * @param compilerOptions Compiler settings.
     * @param config Configuration settings.
     * @param onError A custom error handler.
     */
    IncrementalCompiler.fromOptions = function (compilerOptions, config, onError) {
        return this._fromProjectAndOptions(/*project*/ undefined, compilerOptions, config, onError);
    };
    IncrementalCompiler._fromProjectAndOptions = function (project, compilerOptions, config, onError) {
        if (onError === void 0) { onError = function (err) { return console.log(JSON.stringify(err, null, 4)); }; }
        config = assign({}, config);
        var projectDiagnostic;
        var json;
        if (project) {
            var ts_1 = builder_1.getTypeScript(config);
            var parsed = ts_1.readConfigFile(project, ts_1.sys.readFile);
            if (parsed.error) {
                console.error(parsed.error);
                projectDiagnostic = parsed.error;
            }
            else {
                json = parsed.config;
                if (!config.base)
                    config.base = path_1.resolve(path_1.dirname(project));
            }
        }
        else {
            json = { compilerOptions: compilerOptions, files: [], include: [], exclude: [] };
        }
        if (!config.base)
            config.base = process.cwd();
        return IncrementalCompiler._create(project, json, config, onError, projectDiagnostic);
    };
    IncrementalCompiler._create = function (project, json, config, onError, projectDiagnostic) {
        Object.setPrototypeOf(compiler, IncrementalCompiler.prototype);
        var incrCompiler = compiler;
        incrCompiler._project = project;
        incrCompiler._json = json;
        incrCompiler._config = config;
        incrCompiler._onError = onError;
        incrCompiler._projectDiagnostic = projectDiagnostic;
        return incrCompiler;
        function compiler(token) {
            return compiler._createStream(token);
        }
    };
    /**
     * Creates a copy of this IncrementalCompiler for the provided TypeScript module object.
     *
     * @param typescript A module object for the TypeScript compiler.
     */
    IncrementalCompiler.prototype.withTypeScript = function (typescript) {
        var json = utils_1.collections.structuredClone(this._json);
        var config = assign({}, this._config, { typescript: typescript });
        return IncrementalCompiler._create(this._project, json, config, this._onError, this._projectDiagnostic);
    };
    /**
     * Create a copy of this IncrementalCompiler with additional compiler options.
     *
     * @param compilerOptions additional compiler options.
     */
    IncrementalCompiler.prototype.withCompilerOptions = function (compilerOptions) {
        var json = utils_1.collections.structuredClone(this._json || {});
        json.compilerOptions = assign(json.compilerOptions || {}, compilerOptions);
        var config = assign({}, this._config);
        return IncrementalCompiler._create(this._project, json, config, this._onError, this._projectDiagnostic);
    };
    /**
     * Creates a copy of this IncrementalCompiler.
     */
    IncrementalCompiler.prototype.clone = function () {
        var json = utils_1.collections.structuredClone(this._json);
        var config = assign({}, this._config);
        return IncrementalCompiler._create(this._project, json, config, this._onError, this._projectDiagnostic);
    };
    /**
     * Get a stream of vinyl files from the project.
     *
     * @param options Options to pass to vinyl-fs.
     */
    IncrementalCompiler.prototype.src = function (options) {
        if (!this._project) {
            throw new gutil.PluginError("gulp-tsb", "'src()' is only supported for projects.");
        }
        var ts = builder_1.getTypeScript(this._config);
        var fileNames = this.fileNames;
        var compilerOptions = this.compilerOptions;
        var base = this._config.base;
        if (compilerOptions.rootDir) {
            base = compilerOptions.rootDir;
        }
        else {
            var declarationPattern_1 = /\.d\.ts$/i;
            var commonRoot = fileNames
                .filter(function (file) { return !declarationPattern_1.test(file); })
                .map(function (file) { return file.split(/[\\/]/g); })
                .reduce(function (commonRoot, segments) {
                segments.pop(); // remove the file name.
                if (commonRoot === undefined) {
                    return segments;
                }
                for (var i = 0; i < commonRoot.length && i < segments.length; i++) {
                    if (!utils_1.strings.equal(commonRoot[i], segments[i], !ts.sys.useCaseSensitiveFileNames)) {
                        return commonRoot.slice(0, i);
                    }
                }
                return commonRoot;
            }, undefined);
            if (commonRoot && commonRoot.length > 0) {
                base = commonRoot.join(path_1.sep);
            }
        }
        return vinylfs.src(fileNames, assign({ base: base }, options));
    };
    /**
     * Gets a stream used to compile the project.
     */
    IncrementalCompiler.prototype.compile = function () {
        return this._createStream();
    };
    /**
     * Gets a stream used to write the target files to the output directory specified by the project.
     *
     * @param options Options to pass to vinyl-fs.
     */
    IncrementalCompiler.prototype.dest = function (options) {
        return vinylfs.dest(this.destPath, options);
    };
    IncrementalCompiler.prototype._parseOptions = function (includeFiles) {
        var ts = builder_1.getTypeScript(this._config);
        var json = this._json;
        if (!includeFiles) {
            json = assign({}, json);
            json.include = [];
            json.exclude = [];
            json.files = [];
        }
        return ts.parseJsonConfigFileContent(json, ts.sys, this._config.base, /*existingOptions*/ undefined, this._project);
    };
    IncrementalCompiler.prototype._createStream = function (token) {
        if (this._projectDiagnostic) {
            return null;
        }
        var builder = this.builder;
        var onError = this._onError;
        return through(function (file) {
            // give the file to the compiler
            if (file.isStream()) {
                this.emit('error', 'no support for streams');
                return;
            }
            builder.file(file);
        }, function () {
            var _this = this;
            // start the compilation process
            builder.build(function (file) { return _this.queue(file); }, onError, token).then(function () { return _this.queue(null); });
        });
    };
    return IncrementalCompiler;
}());
exports.IncrementalCompiler = IncrementalCompiler;
// wire up IncrementalCompiler's prototype to the Function prototype.
Object.setPrototypeOf(IncrementalCompiler.prototype, Function.prototype);
function create(projectOrCompilerOptions, verboseOrCreateOptions, json, onError) {
    var verbose;
    var typescript;
    var base;
    var parallel = false;
    if (typeof verboseOrCreateOptions === "boolean") {
        verbose = verboseOrCreateOptions;
    }
    else if (verboseOrCreateOptions) {
        verbose = verboseOrCreateOptions.verbose;
        json = verboseOrCreateOptions.json;
        onError = verboseOrCreateOptions.onError;
        typescript = verboseOrCreateOptions.typescript;
        base = verboseOrCreateOptions.base;
        parallel = verboseOrCreateOptions.parallel;
    }
    json = !!json;
    verbose = !!verbose;
    parallel = !!parallel;
    var config = { json: json, verbose: verbose, parallel: parallel, noFilesystemLookup: false };
    if (typescript)
        config.typescript = typescript;
    if (base)
        config.base = path_1.resolve(base);
    if (typeof projectOrCompilerOptions === 'string') {
        return IncrementalCompiler.fromProject(projectOrCompilerOptions, config, onError);
    }
    else {
        return IncrementalCompiler.fromOptions(projectOrCompilerOptions, config, onError);
    }
}
exports.create = create;
var _childProcessBuilder;
process.on('message', function (data) {
    switch (data.kind) {
        case 'config':
            _childProcessBuilder = builder_1.createTypeScriptBuilder(data.config, data.compilerOptions);
            break;
        case 'file':
            if (!_childProcessBuilder)
                return process.send({ kind: 'error', message: 'config message never received' });
            _childProcessBuilder.file(utils_1.deserializeVinyl(data.file));
            break;
        case 'build':
            if (!_childProcessBuilder)
                return process.send({ kind: 'error', message: 'config message never received' });
            _childProcessBuilder.build(function (file) { return process.send({ kind: 'output', file: utils_1.serializeVinyl(file) }); }, function (message) { return process.send({ kind: 'error', message: message }); }).then(function (value) { return process.send({ kind: 'end-of-output', value: value }); });
            break;
        case 'close':
            process.exit(0);
    }
});
process.on('disconnect', function () {
    _childProcessBuilder = undefined;
});
//# sourceMappingURL=index.js.map
