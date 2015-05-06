/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/vinyl/vinyl.d.ts" />
/// <reference path="../typings/through/through.d.ts" />
/// <reference path="../typings/clone/clone.d.ts" />

import stream = require('stream');
import builder = require('./builder');
import vinyl = require('vinyl');
import through = require('through');
import clone = require('clone');
import fs = require('fs');
import path = require('path');

export function create(configOrName: builder.IConfiguration|string, verbose?:boolean, json?:boolean): () => stream.Stream {
    
    var config: builder.IConfiguration;
    
    if (typeof configOrName === 'string') {
        try {
            var buffer = fs.readFileSync(configOrName);
            config = JSON.parse(buffer.toString())['compilerOptions'];
        } catch (e) {
            console.error(e);
            throw e;
        }
    } else {
        // clone the configuration
        config = clone(configOrName);
    }

    // add those
    config.verbose = config.verbose || verbose;
    config.json = config.json || json;

    var _builder = builder.createTypeScriptBuilder(config);

    function createStream(): stream.Stream {

        return through(function (file: vinyl) { 
            // give the file to the compiler
            if (file.isStream()) {
                this.emit('error', 'no support for streams');
                return;
            }
            _builder.file(file);

        }, function () { 
                // start the compilation process
                _builder.build(file => this.queue(file), err => console.log(err));
                this.queue(null);
            });
    }

    return () => createStream();
}
