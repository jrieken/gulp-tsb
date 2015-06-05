/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/vinyl/vinyl.d.ts" />
/// <reference path="../typings/through/through.d.ts" />
/// <reference path="../typings/clone/clone.d.ts" />
var builder = require('./builder');
var through = require('through');
var clone = require('clone');
var ts = require('./typescript/typescriptServices');
function create(configOrName, verbose, json, onError) {
    var config;
    if (typeof configOrName === 'string') {
        var parsed = ts.readConfigFile(configOrName);
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
        onError = console.log.bind(console);
    }
    console.log(config);
    var _builder = builder.createTypeScriptBuilder(config);
    function createStream() {
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
            _builder.build(function (file) { return _this.queue(file); }, onError);
            this.queue(null);
        });
    }
    return function () { return createStream(); };
}
exports.create = create;
