'use strict';

import Vinyl = require('vinyl');
import * as vinylfs from 'vinyl-fs';
import * as gutil from 'gulp-util';
import * as through from 'through';
import * as ts from 'typescript';
import {createTypeScriptBuilder, CancellationToken, IConfiguration, ITypeScriptBuilder, getTypeScript} from './builder';
import {Transform, Readable} from 'stream';
import {readFileSync, existsSync, readdirSync} from 'fs';
import {extname, dirname, basename, resolve, sep, join, relative} from 'path';
import {strings, collections} from './utils';

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
    private _options: ts.CompilerOptions | undefined;
    private _builder: ITypeScriptBuilder | undefined;
    private _project: string | undefined;
    private _json: any;
    private _base: string;
    private _projectDiagnostic: ts.Diagnostic | undefined;

    private constructor() {
        throw new Error("Not implemented");
    }

    /** Gets the Program created for this compilation. */
    public get program() {
        return this.builder.languageService.getProgram();
    }

    /** Gets the current compiler options. */
    public get compilerOptions() {
        return this._options || (this._options = this._parseOptions(/*includeFiles*/ false).options);
    }

    /** Gets the current file names. */
    public get fileNames() {
        if (!this._project) {
            return [];
        }

        // we do not cache file names between calls to .src() to allow new files to be picked up by
        // the compiler between compilations.  However, we will cache the compiler options if we
        // haven't seen them yet.
        const parsed = this._parseOptions(/*includeFiles*/ true);
        if (!this._options) {
            this._options = parsed.options;
        }

        return parsed.fileNames;
    }

    /** Gets the expected destination path. */
    public get destPath() {
        let destPath = this._base;
        const compilerOptions = this.compilerOptions;
        if (compilerOptions.outDir) {
            destPath = resolve(destPath, compilerOptions.outDir);
        }
        else if (compilerOptions.outFile || compilerOptions.out) {
            const outFile = compilerOptions.outFile || compilerOptions.out;
            destPath = dirname(resolve(destPath, compilerOptions.outFile || compilerOptions.out));
        }
        return relative(process.cwd(), destPath);
    }

    /** Gets the expected sourcemap path (for use with gulp-sourcemaps). */
    public get sourcemapPath() {
        return this.compilerOptions.inlineSourceMap ? undefined : "."
    }

    /** Gets the sourcemap options (for use with gulp-sourcemaps). */
    public get sourcemapOptions() {
        return {
            includeContent: this.compilerOptions.inlineSources,
            destPath: this.destPath
        };
    }

    private get builder() {
        return this._builder || (this._builder = createTypeScriptBuilder(this._config, Object.assign({}, this.compilerOptions)));
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
        return this._fromProjectAndOptions(project, /*options*/ undefined, config, onError);
    }

    /**
     * Create an IncrementalCompiler from a set of options.
     *
     * @param compilerOptions Compiler settings.
     * @param config Configuration settings.
     * @param onError A custom error handler.
     */
    public static fromOptions(compilerOptions: CompilerOptions, config: IConfiguration, onError?: (message: any) => void) {
        return this._fromProjectAndOptions(/*project*/ undefined, compilerOptions, config, onError);
    }

    private static _fromProjectAndOptions(project: string | undefined, compilerOptions: CompilerOptions | undefined, config: IConfiguration, onError: (message: any) => void = (err) => console.log(JSON.stringify(err, null, 4))) {
        let projectDiagnostic: ts.Diagnostic | undefined;
        let json: any;
        let base = process.cwd();
        if (project) {
            const ts = getTypeScript(config);
            const parsed = ts.readConfigFile(project, ts.sys.readFile);
            if (parsed.error) {
                console.error(parsed.error);
                projectDiagnostic = parsed.error;
            }
            else {
                json = parsed.config;
                base = resolve(base, dirname(project));
            }
        }
        else {
            json = { compilerOptions };
        }

        return IncrementalCompiler._create(
            project,
            base,
            json,
            Object.assign({ base }, config),
            onError,
            projectDiagnostic
        );
    }

    private static _create(project: string | undefined, base: string, json: any, config: IConfiguration, onError: (message: any) => void, projectDiagnostic: ts.Diagnostic) {
        const compiler: IncrementalCompiler = <IncrementalCompiler>((token?: CancellationToken) => compiler._createStream(token));
        Object.setPrototypeOf(compiler, IncrementalCompiler.prototype);
        compiler._project = project;
        compiler._base = base;
        compiler._json = json;
        compiler._config = config;
        compiler._onError = onError;
        compiler._projectDiagnostic = projectDiagnostic;
        return compiler;
    }

    /**
     * Creates a copy of this IncrementalCompiler for the provided TypeScript module object.
     *
     * @param typescript A module object for the TypeScript compiler.
     */
    public withTypeScript(typescript: typeof ts) {
        const json = collections.structuredClone(this._json);
        const config = Object.assign({}, this._config, { typescript });
        return IncrementalCompiler._create(this._project, this._base, json, config, this._onError, this._projectDiagnostic);
    }

    /**
     * Create a copy of this IncrementalCompiler with additional compiler options.
     *
     * @param compilerOptions additional compiler options.
     */
    public withCompilerOptions(compilerOptions: CompilerOptions) {
        const json = collections.structuredClone(this._json || {});
        json.compilerOptions = Object.assign(json.compilerOptions || {}, compilerOptions);
        const config = Object.assign({}, this._config);
        return IncrementalCompiler._create(this._project, this._base, json, config, this._onError, this._projectDiagnostic);
    }

    /**
     * Creates a copy of this IncrementalCompiler.
     */
    public clone() {
        const json = collections.structuredClone(this._json);
        const config = Object.assign({}, this._config);
        return IncrementalCompiler._create(this._project, this._base, json, config, this._onError, this._projectDiagnostic);
    }

    /**
     * Get a stream of vinyl files from the project.
     *
     * @param options Options to pass to vinyl-fs.
     */
    public src(options?: vinylfs.ISrcOptions): NodeJS.ReadableStream {
        if (!this._project) {
            throw new gutil.PluginError("gulp-tsb", "'src' is only supported for projects.");
        }

        const ts = getTypeScript(this._config);
        const fileNames = this.fileNames;
        const compilerOptions = this.compilerOptions;
        const base = this._base;
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
     *
     * @param options Options to pass to vinyl-fs.
     */
    public dest(options?: vinylfs.IDestOptions) {
        return vinylfs.dest(this.destPath, options);
    }

    private _parseOptions(includeFiles: boolean) {
        const ts = getTypeScript(this._config);
        let json = this._json;
        if (!includeFiles) {
            json = Object.assign({}, json);
            json.include = [];
            json.exclude = [];
            json.files = [];
        }
        return ts.parseJsonConfigFileContent(json, ts.sys, this._base, /*existingOptions*/ undefined, this._project);
    }

    private _createStream(token?: CancellationToken): Transform | null {
        if (this._projectDiagnostic) {
            return null;
        }

        const builder = this.builder;
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

export interface CreateOptions {
    /** Indicates whether to report compiler diagnostics as JSON instead of as a string. */
    json?: boolean;
    /** Indicates whether to report verbose compilation messages. */
    verbose?: boolean;
    /** Provides an explicit instance of the typescript compiler to use. */
    typescript?: typeof ts;
    /** The base path to use for file resolution. */
    base?: string;
    /** Custom callback used to report compiler diagnostics. */
    onError?: (message: any) => void;
}

export interface CompilerOptions {
    [option: string]: ts.CompilerOptionsValue;
}

/**
 * Create an IncrementalCompiler from a tsconfig.json file.
 *
 * @param project The path to a tsconfig.json file or its parent directory.
 * @param createOptions Options to pass on to the IncrementalCompiler.
 */
export function create(project: string, createOptions?: CreateOptions): IncrementalCompiler;

/**
 * Create an IncrementalCompiler from a tsconfig.json file.
 *
 * @param project The path to a tsconfig.json file or its parent directory.
 * @param verbose Indicates whether to report verbose compilation messages.
 * @param json Indicates whether to report compiler diagnostics as JSON instead of as a string.
 * @param onError Custom callback used to report compiler diagnostics.
 */
export function create(project: string, verbose?: boolean, json?: boolean, onError?: (message: any) => void): IncrementalCompiler;

/**
 * Create an IncrementalCompiler from a set of options.
 *
 * @param compilerOptions Options to pass on to the TypeScript compiler.
 * @param createOptions Options to pass on to the IncrementalCompiler.
 */
export function create(compilerOptions: CompilerOptions, createOptions?: CreateOptions): IncrementalCompiler;

/**
 * Create an IncrementalCompiler from a set of options.
 *
 * @param compilerOptions Options to pass on to the TypeScript compiler.
 * @param verbose Indicates whether to report verbose compilation messages.
 * @param json Indicates whether to report compiler diagnostics as JSON instead of as a string.
 * @param onError Custom callback used to report compiler diagnostics.
 */
export function create(compilerOptions: CompilerOptions, verbose?: boolean, json?: boolean, onError?: (message: any) => void): IncrementalCompiler;

export function create(projectOrCompilerOptions: CompilerOptions | string, verboseOrCreateOptions?: boolean | CreateOptions, json?: boolean, onError?: (message: any) => void): IncrementalCompiler {
    let verbose: boolean;
    let typescript: typeof ts;
    let base: string;
    if (typeof verboseOrCreateOptions === "boolean") {
        verbose = verboseOrCreateOptions;
    }
    else if (verboseOrCreateOptions) {
        verbose = verboseOrCreateOptions.verbose;
        json = verboseOrCreateOptions.json;
        onError = verboseOrCreateOptions.onError;
        typescript = verboseOrCreateOptions.typescript;
        base = verboseOrCreateOptions.base;
    }

    const config: IConfiguration = { json, verbose, noFilesystemLookup: false, typescript };
    if (base) {
        config.base = resolve(base);
    }

    if (typeof projectOrCompilerOptions === 'string') {
        return IncrementalCompiler.fromProject(projectOrCompilerOptions, config, onError);
    }
    else {
        return IncrementalCompiler.fromOptions(projectOrCompilerOptions, config, onError);
    }
}
