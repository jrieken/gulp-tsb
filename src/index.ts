'use strict';

import Vinyl = require('vinyl');
import * as vinylfs from 'vinyl-fs';
import * as gutil from 'gulp-util';
import * as through from 'through';
import * as ts from 'typescript';
import {createTypeScriptBuilder, CancellationToken, IConfiguration, ITypeScriptBuilder} from './builder';
import {Transform} from 'stream';
import {readFileSync, existsSync, readdirSync} from 'fs';
import {extname, dirname, basename, resolve, delimiter} from 'path';
import {strings} from './utils';

declare module "through" {
    interface ThroughStream {
        queue(data: any): void;
    }
}

declare module "stream" {
    interface ReadableOptions {
        read?(size: number): void;
    }
}

declare module "vinyl-fs" {
    interface IDestOptions {
        /** Specify the working directory the folder is relative to
         * Default is process.cwd()
         */
        cwd?: string;

        /** Specify the mode the files should be created with
         * Default is the mode of the input file (file.stat.mode)
         * or the process mode if the input file has no mode property
         */
        mode?: number|string;

        /** Specify the mode the directory should be created with. Default is the process mode */
        dirMode?: number|string;

        /** Specify if existing files with the same path should be overwritten or not. Default is true, to always overwrite existing files */
        overwrite?: boolean;
    }
}

export interface IncrementalCompiler {
    (): Transform;
}

export class IncrementalCompiler {
    private _onError: (message: any) => void;
    private _config: IConfiguration;
    private _options: ts.CompilerOptions;
    private _builder: ITypeScriptBuilder;
    private _project: string | undefined;
    private _json: any;

    private constructor() {
        throw new Error("Not implemented");
    }

    /**
     * Gets the Program created for this compilation.
     */
    public get program() {
        return this._builder.languageService.getProgram();
    }

    /**
     * Create an IncrementalCompiler from a tsconfig.json file.
     *
     * @param project The path to a tsconfig.json file or its parent directory.
     * @param config Configuration settings.
     * @param onError A custom error handler.
     */
    public static fromProject(project: string, config: IConfiguration, onError?: (message: any) => void) {
        const possibleProject = resolve(project, "tsconfig.json");
        if (existsSync(possibleProject)) {
            project = possibleProject;
        }
        return this._create(project, config, onError);
    }

    /**
     * Create an IncrementalCompiler from a set of options.
     *
     * @param config Configuration settings.
     * @param onError A custom error handler.
     */
    public static fromConfig(config: IConfiguration, onError?: (message: any) => void) {
        return this._create(/*project*/ undefined, config, onError);
    }

    private static _create(project: string | undefined, config: IConfiguration, onError: (message: any) => void = (err) => console.log(JSON.stringify(err, null, 4))) {
        let compiler: IncrementalCompiler | undefined;
        let options: ts.CompilerOptions;
        let json: any;
        let builder: ITypeScriptBuilder;
        let base = process.cwd();
        if (project) {
            const parsed = ts.readConfigFile(project, ts.sys.readFile);
            if (parsed.error) {
                console.error(parsed.error);
                compiler = <IncrementalCompiler>((token?: CancellationToken) => through(write => {}) as Transform);
            }
            else {
                json = parsed.config;
                base = resolve(base, dirname(project));
            }
        }
        else {
            json = { compilerOptions: config };
        }

        if (json !== undefined) {
            options = ts.parseJsonConfigFileContent(json, ts.sys, base, /*existingOptions*/ undefined, project).options;
            builder = createTypeScriptBuilder(config, options);
        }

        if (compiler === undefined) {
            compiler = <IncrementalCompiler>((token?: CancellationToken) => compiler._createStream(token));
        }

        // Wire up the function's prototype to IncrementalCompiler's prototype
        Object.setPrototypeOf(compiler, IncrementalCompiler.prototype);
        compiler._project = project;
        compiler._json = json;
        compiler._config = config;
        compiler._options = options;
        compiler._onError = onError;
        compiler._builder = builder;
        return compiler;
    }

    /**
     * Get a stream of vinyl files from the project.
     */
    public src(options?: vinylfs.ISrcOptions) {
        let base = process.cwd();
        if (this._project) {
            base = resolve(base, dirname(this._project));
        }
        const { fileNames } = ts.parseJsonConfigFileContent(this._json, ts.sys, base, /*existingOptions*/ undefined, this._project);
        if (this._options.rootDir) {
            base = resolve(base, this._options.rootDir);
        }
        else {
            const declarationPattern = /\.d\.ts$/i;
            const commonRoot = fileNames
                .filter(file => !declarationPattern.test(file))
                .map(file => file.split(/[\\/]/g))
                .reduce((commonRoot, segments) => {
                    segments.pop(); // remove the file name.
                    if (commonRoot === undefined) {
                        return segments;
                    }
                    for (let i = 0; i < commonRoot.length && i < segments.length; i++) {
                        if (!strings.equal(commonRoot[i], segments[i], !ts.sys.useCaseSensitiveFileNames)) {
                            return commonRoot.slice(0, i);
                        }
                    }
                    return commonRoot;
                }, undefined);
            if (commonRoot && commonRoot.length > 0) {
                base = commonRoot.join(delimiter);
            }
        }
        return vinylfs.src(fileNames, Object.assign({ base }, options));
    }

    /**
     * Gets a stream used to compile the project.
     */
    public compile() {
        return this();
    }

    /**
     * Gets a stream used to write the target files to the output directory specified by the project.
     */
    public dest(options?: vinylfs.IDestOptions) {
        let dest = process.cwd();
        if (this._project) {
            dest = resolve(dest, dirname(this._project));
        }
        if (this._options.outDir) {
            dest = resolve(dest, this._options.outDir);
        }
        else if (this._options.out || this._options.outFile) {
            dest = resolve(dest, dirname(this._options.out || this._options.outFile || ""));
        }
        return vinylfs.dest(dest, options);
    }

    private _createStream(token?: CancellationToken): Transform {
        const builder = this._builder;
        const onError = this._onError;
        return through(function (this: through.ThroughStream, file: Vinyl) {
            // give the file to the compiler
            if (file.isStream()) {
                this.emit('error', 'no support for streams');
                return;
            }
            builder.file(file);
        }, function (this: through.ThroughStream) {
            // start the compilation process
            builder.build(file => this.queue(file), onError, token).then(() => this.queue(null));
        });
    }
}

// wire up IncrementalCompiler's prototype to the Function prototype.
Object.setPrototypeOf(IncrementalCompiler.prototype, Function.prototype);

export function create(configOrName: { [option: string]: string | number | boolean; } | string, verbose?: boolean, json?: boolean, onError?: (message: any) => void): IncrementalCompiler {
    let config: IConfiguration = { json, verbose, noFilesystemLookup: false };
    if (typeof configOrName === 'string') {
        return IncrementalCompiler.fromProject(configOrName, config, onError);
    }
    else {
        return IncrementalCompiler.fromConfig(Object.assign(config, configOrName), onError);
    }
}
