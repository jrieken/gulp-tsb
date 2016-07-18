'use strict';
export module collections {

    var hasOwnProperty = Object.prototype.hasOwnProperty;

    export function lookup<T>(collection: { [keys: string]: T }, key: string): T | null {
        if (hasOwnProperty.call(collection, key)) {
            return collection[key];
        }
        return null;
    }

    export function insert<T>(collection: { [keys: string]: T }, key: string, value: T): void {
        collection[key] = value;
    }

    export function lookupOrInsert<T>(collection: { [keys: string]: T }, key: string, value: T): T {
        if (hasOwnProperty.call(collection, key)) {
            return collection[key];
        } else {
            collection[key] = value;
            return value;
        }
    }

    export function forEach<T>(collection: { [keys: string]: T }, callback: (entry: { key: string; value: T; }) => void): void {
        for (var key in collection) {
            if (hasOwnProperty.call(collection, key)) {
                callback({
                    key: key,
                    value: collection[key]
                });
            }
        }
    }

    export function contains(collection: { [keys: string]: any }, key: string): boolean {
        return hasOwnProperty.call(collection, key);
    }

    export function structuredClone<T>(value: T): T {
        return structuredCloneRecursive(value, new Map<any, any>());
    }

    function structuredCloneRecursive(value: any, objects: Map<any, any>) {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== "object") return value;
        let clone = objects.get(value);
        if (clone === undefined) {
            clone = Array.isArray(value) ? Array<any>(value.length) : {};
            objects.set(value, clone);
            for (const key in value) {
                if (contains(value, key)) {
                    clone[key] = structuredCloneRecursive(value[key], objects);
                }
            }
        }
        return clone;
    }
}

export module strings {

	/**
	 * The empty string. The one and only.
	 */
    export var empty = '';

    export var eolUnix = '\r\n';

    export function format(value: string, ...rest: any[]): string {
        return value.replace(/({\d+})/g, function (match) {
            var index = match.substring(1, match.length - 1);
            return rest[+index] || match;
        });
    }

    export function equal(left: string, right: string, ignoreCase?: boolean) {
        return ignoreCase
            ? left.toUpperCase() === right.toUpperCase()
            : left === right;
    }
}

export module graph {

    export interface Node<T> {
        data: T;
        incoming: { [key: string]: Node<T> };
        outgoing: { [key: string]: Node<T> };
    }

    export function newNode<T>(data: T): Node<T> {
        return {
            data: data,
            incoming: {},
            outgoing: {}
        };
    }

    export class Graph<T> {

        private _nodes: { [key: string]: Node<T> } = {};

        constructor(private _hashFn: (element: T) => string) {
            // empty
        }

        public traverse(start: T, inwards: boolean, callback: (data: T) => void): void {
            var startNode = this.lookup(start);
            if (!startNode) {
                return;
            }
            this._traverse(startNode, inwards, {}, callback);
        }

        private _traverse(node: Node<T>, inwards: boolean, seen: { [key: string]: boolean }, callback: (data: T) => void): void {
            var key = this._hashFn(node.data);
            if (collections.contains(seen, key)) {
                return;
            }
            seen[key] = true;
            callback(node.data);
            var nodes = inwards ? node.outgoing : node.incoming;
            collections.forEach(nodes,(entry) => this._traverse(entry.value, inwards, seen, callback));
        }

        public inertEdge(from: T, to: T): void {
            var fromNode = this.lookupOrInsertNode(from),
                toNode = this.lookupOrInsertNode(to);

            fromNode.outgoing[this._hashFn(to)] = toNode;
            toNode.incoming[this._hashFn(from)] = fromNode;
        }

        public removeNode(data: T): void {
            var key = this._hashFn(data);
            delete this._nodes[key];
            collections.forEach(this._nodes,(entry) => {
                delete entry.value.outgoing[key];
                delete entry.value.incoming[key];
            });
        }

        public lookupOrInsertNode(data: T): Node<T> {
            var key = this._hashFn(data),
                node = collections.lookup(this._nodes, key);

            if (!node) {
                node = newNode(data);
                this._nodes[key] = node;
            }

            return node;
        }

        public lookup(data: T): Node<T> | null {
            return collections.lookup(this._nodes, this._hashFn(data));
        }
    }

}
