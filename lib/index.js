/// <reference path="../node_modules/typescript/lib/lib.es6.d.ts"/>
'use strict';
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
var through = require("through");
var builder = require("./builder");
var ts = require("typescript");
var fs_1 = require("fs");
var path_1 = require("path");
// We actually only want to read the tsconfig.json file. So all methods
// to read the FS are 'empty' implementations.
var _parseConfigHost = {
    useCaseSensitiveFileNames: false,
    fileExists: function (fileName) {
        return fs_1.existsSync(fileName);
    },
    readDirectory: function (rootDir, extensions, excludes, includes) {
        return []; // don't want to find files!
    },
    readFile: function (fileName) {
        return fs_1.readFileSync(fileName, 'utf-8');
    },
};
function create(configOrName, verbose, json, onError) {
    var config = {
        json: json,
        verbose: verbose,
        noFilesystemLookup: false,
        excludeNodeModulesFromRootNames: false,
        base: process.cwd()
    };
    return createWithIConfiguration(configOrName, config, onError);
}
exports.create = create;
function createWithIConfiguration(configOrName, config, onError) {
    // copy the config so as not to possibly mutate shared settings.
    config = __assign({}, config);
    if (config.base === undefined)
        config.base = process.cwd();
    if (config.noFilesystemLookup === undefined)
        config.noFilesystemLookup = false;
    if (config.excludeNodeModulesFromRootNames === undefined)
        config.excludeNodeModulesFromRootNames = false;
    var options;
    if (typeof configOrName === 'string') {
        var parsed = ts.readConfigFile(configOrName, _parseConfigHost.readFile);
        if (parsed.error) {
            console.error(parsed.error);
            return function () { return null; };
        }
        options = ts.parseJsonConfigFileContent(parsed.config, _parseConfigHost, path_1.dirname(configOrName), undefined, configOrName).options;
        config.base = path_1.resolve(path_1.dirname(configOrName));
    }
    else {
        if (configOrName.base) {
            config.base = configOrName.base;
        }
        options = ts.parseJsonConfigFileContent({ compilerOptions: configOrName }, _parseConfigHost, config.base).options;
        Object.assign(config, configOrName);
    }
    if (!onError) {
        onError = function (err) { return console.log(JSON.stringify(err, null, 4)); };
    }
    var _builder = builder.createTypeScriptBuilder(config, options);
    function createStream(token) {
        return through(function (file) {
            // give the file to the compiler
            if (file.isStream()) {
                this.emit('error', 'no support for streams');
                return;
            }
            _builder.file(file);
        }, function () {
            var _this = this;
            // start the compilation process
            _builder.build(function (file) { return _this.queue(file); }, onError, token).then(function () { return _this.queue(null); });
        });
    }
    var result = function (token) { return createStream(token); };
    Object.defineProperty(result, 'program', { get: function () { return _builder.getProgram(); } });
    return result;
}
exports.createWithIConfiguration = createWithIConfiguration;
