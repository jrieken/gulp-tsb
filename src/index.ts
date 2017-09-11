/// <reference path="../node_modules/typescript/lib/lib.es6.d.ts"/>

'use strict';

import vinyl = require('vinyl');
import * as through from 'through';
import * as builder from './builder';
import * as ts from 'typescript';
import {Stream} from 'stream';
import {readFileSync, existsSync, readdirSync} from 'fs';
import {extname, dirname, resolve} from 'path';

// We actually only want to read the tsconfig.json file. So all methods
// to read the FS are 'empty' implementations.
const _parseConfigHost = {
    useCaseSensitiveFileNames: false,
    fileExists(fileName: string): boolean {
        return existsSync(fileName);
    },
    readDirectory(rootDir: string, extensions: string[], excludes: string[], includes: string[]): string[] {
        return []; // don't want to find files!
    },
    readFile(fileName: string): string {
        return readFileSync(fileName, 'utf-8');
    },
};

export interface IncrementalCompiler {
    (): Stream;
    program?: ts.Program;
}

export function create(configOrName: { [option: string]: string | number | boolean; } | string, verbose?: boolean, json?: boolean, onError?: (message: any) => void): IncrementalCompiler {

    let options = ts.getDefaultCompilerOptions();
    let config: builder.IConfiguration = { json, verbose, noFilesystemLookup: false };

    if (typeof configOrName === 'string') {
        let parsed = ts.readConfigFile(configOrName, _parseConfigHost.readFile);
        if (parsed.error) {
            console.error(parsed.error);
            return () => null;
        }

        options = ts.parseJsonConfigFileContent(parsed.config, _parseConfigHost, dirname(configOrName), undefined, configOrName).options;
        config.base = resolve(dirname(configOrName));
    } else {
        options = ts.parseJsonConfigFileContent({ compilerOptions: configOrName }, _parseConfigHost, './').options;
        Object.assign(config, configOrName);
    }

    if (!onError) {
        onError = (err) => console.log(JSON.stringify(err, null, 4));
    }

    if (!config.base) config.base = process.cwd();

    const _builder = builder.createTypeScriptBuilder(config, options);

    function createStream(token?: builder.CancellationToken): Stream {

        return through(function (file: vinyl) {
            // give the file to the compiler
            if (file.isStream()) {
                this.emit('error', 'no support for streams');
                return;
            }
            _builder.file(file);
        }, function () {
            // start the compilation process
            _builder.build(file => this.queue(file), onError, token).then(() => this.queue(null));
        });
    }

    let result = (token: builder.CancellationToken) => createStream(token);
    Object.defineProperty(result, 'program', { get: () => _builder.languageService.getProgram() });

    return <IncrementalCompiler> result;
}
