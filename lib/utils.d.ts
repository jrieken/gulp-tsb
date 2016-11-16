/// <reference types="vinyl" />
import Vinyl = require('vinyl');
export declare namespace collections {
    function lookup<T>(collection: {
        [keys: string]: T;
    }, key: string): T | null;
    function insert<T>(collection: {
        [keys: string]: T;
    }, key: string, value: T): void;
    function lookupOrInsert<T>(collection: {
        [keys: string]: T;
    }, key: string, value: T): T;
    function forEach<T>(collection: {
        [keys: string]: T;
    }, callback: (entry: {
        key: string;
        value: T;
    }) => void): void;
    function contains(collection: {
        [keys: string]: any;
    }, key: string): boolean;
    function structuredClone<T>(value: T): T;
}
export declare namespace strings {
    /**
     * The empty string. The one and only.
     */
    var empty: string;
    var eolUnix: string;
    function format(value: string, ...rest: any[]): string;
    function equal(left: string, right: string, ignoreCase?: boolean): boolean;
}
export declare namespace graph {
    interface Node<T> {
        data: T;
        incoming: {
            [key: string]: Node<T>;
        };
        outgoing: {
            [key: string]: Node<T>;
        };
    }
    function newNode<T>(data: T): Node<T>;
    class Graph<T> {
        private _hashFn;
        private _nodes;
        constructor(_hashFn: (element: T) => string);
        traverse(start: T, inwards: boolean, callback: (data: T) => void): void;
        private _traverse(node, inwards, seen, callback);
        inertEdge(from: T, to: T): void;
        removeNode(data: T): void;
        lookupOrInsertNode(data: T): Node<T>;
        lookup(data: T): Node<T> | null;
    }
}
export interface SerializedVinyl {
    cwd: string;
    base: string;
    history: string[];
    stat: {
        [index: string]: {
            kind: string;
            value: any;
        };
    };
    sourceMap?: any;
    contents: string;
}
export declare function deserializeVinyl(file: SerializedVinyl): Vinyl;
export declare function serializeVinyl(file: Vinyl): SerializedVinyl;
