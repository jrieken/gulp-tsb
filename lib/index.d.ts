/// <reference types="node" />
import * as ts from 'typescript';
import { Readable, Writable } from 'stream';
export interface IncrementalCompiler {
    (): Readable & Writable;
    src(): Readable;
}
export declare function create(projectPath: string, existingOptions: Partial<ts.CompilerOptions>, verbose?: boolean, onError?: (message: any) => void): IncrementalCompiler;
