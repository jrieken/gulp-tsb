/// <reference types="node" />
import * as ts from 'typescript';
import { Readable, Writable } from 'stream';
export interface IncrementalCompiler {
    (token?: any): Readable & Writable;
    src(opts?: {
        cwd?: string;
        base?: string;
    }): Readable;
}
export declare function create(projectPath: string, existingOptions: Partial<ts.CompilerOptions>, verbose?: boolean, onError?: (message: string) => void): IncrementalCompiler;
