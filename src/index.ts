'use strict';

import vinyl = require('vinyl');
import * as through from 'through';
import * as builder from './builder';
import * as ts from 'typescript';
import { Stream } from 'stream';
import { readFileSync, existsSync } from 'fs';
import { dirname } from 'path';

// We actually only want to read the tsconfig.json file. So all methods
// to read the FS are 'empty' implementations.
const _parseConfigHost = {
    useCaseSensitiveFileNames: false,
    fileExists(fileName: string): boolean {
        return existsSync(fileName);
    },
    readDirectory(_rootDir: string, _extensions: string[], _excludes: string[], _includes: string[]): string[] {
        return []; // don't want to find files!
    },
    readFile(fileName: string): string {
        return readFileSync(fileName, 'utf-8');
    },
};

export interface IncrementalCompiler {
    (): Stream | null;
    program?: ts.Program;
}

const _defaultOnError = (err: any) => console.log(JSON.stringify(err, null, 4));

export function create(
    configOrName: { [option: string]: string | number | boolean; } | string,
    verbose: boolean = false,
    json: boolean = false,
    onError: (message: any) => void = _defaultOnError
): IncrementalCompiler {

    let options = ts.getDefaultCompilerOptions();
    let config: builder.IConfiguration = { json, verbose, noFilesystemLookup: false };

    if (typeof configOrName === 'string') {
        const parsed = ts.readConfigFile(configOrName, _parseConfigHost.readFile);
        options = ts.parseJsonConfigFileContent(parsed.config, _parseConfigHost, dirname(configOrName)).options;
        if (parsed.error) {
            console.error(parsed.error);
            return () => null;
        }
    } else {
        const base = typeof configOrName.base === 'string' ? configOrName.base : './';
        options = ts.parseJsonConfigFileContent({ compilerOptions: configOrName }, _parseConfigHost, base).options;
        Object.assign(config, configOrName);
    }

    const _builder = builder.createTypeScriptBuilder(config, options);

    function createStream(token?: builder.CancellationToken): Stream {

        return through(function (this: through.ThroughStream, file: vinyl) {
            // give the file to the compiler
            if (file.isStream()) {
                this.emit('error', 'no support for streams');
                return;
            }
            _builder.file(file);
        }, function (this: { queue(a: any): void }) { //todo@joh not sure...
            // start the compilation process
            _builder.build(file => this.queue(file), onError, token).then(() => this.queue(null));
        });
    }

    let result = (token: builder.CancellationToken) => createStream(token);
    Object.defineProperty(result, 'program', { get: () => _builder.languageService.getProgram() });

    return <IncrementalCompiler>result;
}
