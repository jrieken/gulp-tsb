/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/vinyl/vinyl.d.ts" />
/// <reference path="../typings/through/through.d.ts" />
/// <reference path="../typings/clone/clone.d.ts" />
var builder = require('./builder');
var through = require('through');
var clone = require('clone');
var fs = require('fs');
function create(configOrName, verbose, json) {
    var config;
    if (typeof configOrName === 'string') {
        try {
            var buffer = fs.readFileSync(configOrName);
            config = JSON.parse(buffer.toString())['compilerOptions'];
        }
        catch (e) {
            console.error(e);
            throw e;
        }
    }
    else {
        // clone the configuration
        config = clone(configOrName);
    }
    // add those
    config.verbose = config.verbose || verbose;
    config.json = config.json || json;
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
            _builder.build(function (file) { return _this.queue(file); }, function (err) { return console.log(err); });
            this.queue(null);
        });
    }
    return function () { return createStream(); };
}
exports.create = create;
