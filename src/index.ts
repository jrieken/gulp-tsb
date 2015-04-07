/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/vinyl/vinyl.d.ts" />
/// <reference path="../typings/through/through.d.ts" />
/// <reference path="../typings/clone/clone.d.ts" />

import stream = require('stream');
import builder = require('./builder');
import vinyl = require('vinyl');
import through = require('through');
import clone = require('clone');

export function create(config: builder.IConfiguration): () => stream.Stream {
    
    // clone the configuration
    config = clone(config);

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