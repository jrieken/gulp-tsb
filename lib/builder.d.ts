import Vinyl = require('vinyl');
import * as ts from 'typescript';
export interface IConfiguration {
    /** Indicates whether to report compiler diagnostics as JSON instead of as a string. */
    json: boolean;
    /** Indicates whether to avoid filesystem lookups for non-root files. */
    noFilesystemLookup: boolean;
    /** Indicates whether to report verbose compilation messages. */
    verbose: boolean;
    /** Provides an explicit instance of the typescript compiler to use. */
    typescript?: typeof ts;
    /** Indicates the base path from which a project was loaded or compilation was started. */
    base?: string;
    _emitWithoutBasePath?: boolean;
    _emitLanguageService?: boolean;
}
export interface CancellationToken {
    isCancellationRequested(): boolean;
}
export declare namespace CancellationToken {
    const None: CancellationToken;
}
export interface ITypeScriptBuilder {
    build(out: (file: Vinyl) => void, onError: (err: any) => void, token?: CancellationToken): Promise<any>;
    file(file: Vinyl): void;
    languageService: ts.LanguageService;
}
export declare function getTypeScript(config: IConfiguration): typeof ts;
export declare function createTypeScriptBuilder(config: IConfiguration, compilerOptions: ts.CompilerOptions): ITypeScriptBuilder;
