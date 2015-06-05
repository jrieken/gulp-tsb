'use strict';

import stream = require('stream');
import builder = require('./builder');
import vinyl = require('vinyl');
import through = require('through');
import clone = require('clone');
import fs = require('fs');
import path = require('path');
import ts = require('./typescript/typescriptServices');

export function create(configOrName: builder.IConfiguration|string, verbose?: boolean, json?: boolean, onError?: (message: any) => void): () => stream.Stream {

    var config: builder.IConfiguration;

    if (typeof configOrName === 'string') {
        var parsed = ts.readConfigFile(configOrName);
        if (parsed.error) {
            console.error(parsed.error);
            return () => null;
        }
        config = parsed.config.compilerOptions;

    } else {
        // clone the configuration
        config = clone(configOrName);
    }

    // add those
    config.verbose = config.verbose || verbose;
    config.json = config.json || json;
    
    if (!onError) {
        onError = console.log.bind(console);
    }

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
            _builder.build(file => this.queue(file), onError);
            this.queue(null);
        });
    }

    return () => createStream();
}
