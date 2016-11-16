/// <reference types="node" />
import * as vinylfs from 'vinyl-fs';
import * as ts from 'typescript';
import { IConfiguration } from './builder';
import { Transform } from 'stream';
declare module "through" {
    interface ThroughStream {
        queue(data: any): void;
    }
}
export interface IVinylDestOptions {
    /** Specify the working directory the folder is relative to
     * Default is process.cwd()
     */
    cwd?: string;
    /** Specify the mode the files should be created with
     * Default is the mode of the input file (file.stat.mode)
     * or the process mode if the input file has no mode property
     */
    mode?: number | string;
    /** Specify the mode the directory should be created with. Default is the process mode */
    dirMode?: number | string;
    /** Specify if existing files with the same path should be overwritten or not. Default is true, to always overwrite existing files */
    overwrite?: boolean;
}
export interface IncrementalCompiler {
    (): Transform;
}
export declare class IncrementalCompiler {
    private _onError;
    private _config;
    private _options;
    private _builder;
    private _project;
    private _json;
    private _projectDiagnostic;
    private _globs;
    private constructor();
    /** Gets the current compiler options. */
    readonly compilerOptions: ts.CompilerOptions;
    /** Gets the current file names. */
    readonly fileNames: string[];
    /** Gets glob patterns used to match files in the project. */
    readonly globs: string[];
    /** Gets the expected destination path. */
    readonly destPath: string;
    /** Gets the expected sourcemap path (for use with gulp-sourcemaps). */
    readonly sourcemapPath: string | undefined;
    /** Gets the sourcemap options (for use with gulp-sourcemaps). */
    readonly sourcemapOptions: {
        includeContent: boolean | undefined;
        destPath: string;
    };
    private _createBuilderProxy();
    private readonly builder;
    /**
     * Create an IncrementalCompiler from a tsconfig.json file.
     *
     * @param project The path to a tsconfig.json file or its parent directory.
     * @param config Configuration settings.
     * @param onError A custom error handler.
     */
    static fromProject(project: string, config: IConfiguration, onError?: (message: any) => void): IncrementalCompiler;
    /**
     * Create an IncrementalCompiler from a set of options.
     *
     * @param compilerOptions Compiler settings.
     * @param config Configuration settings.
     * @param onError A custom error handler.
     */
    static fromOptions(compilerOptions: CompilerOptions, config: IConfiguration, onError?: (message: any) => void): IncrementalCompiler;
    private static _fromProjectAndOptions(project, compilerOptions, config, onError?);
    private static _create(project, json, config, onError, projectDiagnostic);
    /**
     * Creates a copy of this IncrementalCompiler for the provided TypeScript module object.
     *
     * @param typescript A module object for the TypeScript compiler.
     */
    withTypeScript(typescript: typeof ts): IncrementalCompiler;
    /**
     * Create a copy of this IncrementalCompiler with additional compiler options.
     *
     * @param compilerOptions additional compiler options.
     */
    withCompilerOptions(compilerOptions: CompilerOptions): IncrementalCompiler;
    /**
     * Creates a copy of this IncrementalCompiler.
     */
    clone(): IncrementalCompiler;
    /**
     * Get a stream of vinyl files from the project.
     *
     * @param options Options to pass to vinyl-fs.
     */
    src(options?: vinylfs.ISrcOptions): NodeJS.ReadableStream;
    /**
     * Gets a stream used to compile the project.
     */
    compile(): Transform | null;
    /**
     * Gets a stream used to write the target files to the output directory specified by the project.
     *
     * @param options Options to pass to vinyl-fs.
     */
    dest(options?: IVinylDestOptions): NodeJS.ReadWriteStream;
    private _parseOptions(includeFiles);
    private _createStream(token?);
}
export interface CreateOptions {
    /** Indicates whether to report compiler diagnostics as JSON instead of as a string. */
    json?: boolean;
    /** Indicates whether to report verbose compilation messages. */
    verbose?: boolean;
    /** Provides an explicit instance of the typescript compiler to use. */
    typescript?: typeof ts;
    /** The base path to use for file resolution. */
    base?: string;
    /** Indicates whether to run the build in a seperate process. */
    parallel?: boolean;
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
export declare function create(project: string, createOptions?: CreateOptions): IncrementalCompiler;
/**
 * Create an IncrementalCompiler from a tsconfig.json file.
 *
 * @param project The path to a tsconfig.json file or its parent directory.
 * @param verbose Indicates whether to report verbose compilation messages.
 * @param json Indicates whether to report compiler diagnostics as JSON instead of as a string.
 * @param onError Custom callback used to report compiler diagnostics.
 */
export declare function create(project: string, verbose?: boolean, json?: boolean, onError?: (message: any) => void): IncrementalCompiler;
/**
 * Create an IncrementalCompiler from a set of options.
 *
 * @param compilerOptions Options to pass on to the TypeScript compiler.
 * @param createOptions Options to pass on to the IncrementalCompiler.
 */
export declare function create(compilerOptions: CompilerOptions, createOptions?: CreateOptions): IncrementalCompiler;
/**
 * Create an IncrementalCompiler from a set of options.
 *
 * @param compilerOptions Options to pass on to the TypeScript compiler.
 * @param verbose Indicates whether to report verbose compilation messages.
 * @param json Indicates whether to report compiler diagnostics as JSON instead of as a string.
 * @param onError Custom callback used to report compiler diagnostics.
 */
export declare function create(compilerOptions: CompilerOptions, verbose?: boolean, json?: boolean, onError?: (message: any) => void): IncrementalCompiler;
