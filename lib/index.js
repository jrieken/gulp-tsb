'use strict';
var through = require('through');
var clone = require('clone');
var builder = require('./builder');
var typescriptServices_1 = require('./typescript/typescriptServices');
var fs_1 = require('fs');
function create(configOrName, verbose, json, onError) {
    var config;
    if (typeof configOrName === 'string') {
        var parsed = typescriptServices_1.readConfigFile(configOrName, function (path) { return fs_1.readFileSync(path, undefined); });
        if (parsed.error) {
            console.error(parsed.error);
            return function () { return null; };
        }
        config = parsed.config.compilerOptions;
    }
    else {
        // clone the configuration
        config = clone(configOrName);
    }
    // add those
    config.verbose = config.verbose || verbose;
    config.json = config.json || json;
    if (!onError) {
        onError = function (err) { return console.log(JSON.stringify(err, null, 4)); };
    }
    var _builder = builder.createTypeScriptBuilder(config);
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
