import * as ts from 'typescript';
import * as Vinyl from 'vinyl';
export interface IConfiguration {
    verbose: boolean;
    _emitWithoutBasePath?: boolean;
}
export interface CancellationToken {
    isCancellationRequested(): boolean;
}
export declare namespace CancellationToken {
    const None: CancellationToken;
}
export interface ITypeScriptBuilder {
    build(out: (file: Vinyl) => void, onError: (err: ts.Diagnostic) => void, token?: CancellationToken): Promise<any>;
    file(file: Vinyl): void;
    languageService: ts.LanguageService;
}
export declare function createTypeScriptBuilder(config: IConfiguration, projectFile: string, cmd: ts.ParsedCommandLine): ITypeScriptBuilder;
