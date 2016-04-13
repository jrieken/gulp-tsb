/// <reference path="../node_modules/typescript/lib/lib.es6.d.ts"/>
'use strict';
var through = require('through');
var builder = require('./builder');
var ts = require('typescript');
var fs_1 = require('fs');
var _parseConfigHost = {
    readFile: function (fileName) {
        return fs_1.readFileSync(fileName, 'utf-8');
    },
    readDirectory: function (rootDir, extension, exclude) {
        return []; // don't want to find files!
    },
};
function create(configOrName, verbose, json, onError) {
    var options = ts.getDefaultCompilerOptions();
    var config = { json: json, verbose: verbose, noFilesystemLookup: false };
    if (typeof configOrName === 'string') {
        var parsed = ts.readConfigFile(configOrName, function (path) { return fs_1.readFileSync(path, 'utf-8'); });
        options = ts.parseJsonConfigFileContent(parsed.config, _parseConfigHost, __dirname).options;
        if (parsed.error) {
            console.error(parsed.error);
            return function () { return null; };
        }
    }
    else {
        options = ts.parseJsonConfigFileContent(configOrName, _parseConfigHost, __dirname).options;
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
    return function (token) { return createStream(token); };
}
exports.create = create;
