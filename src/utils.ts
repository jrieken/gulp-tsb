'use strict';

export module collections {

    var hasOwnProperty = Object.prototype.hasOwnProperty;

    export function lookup<T>(collection: { [keys: string]: T }, key: string): T {
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
            return rest[index] || match;
        });
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

        public lookup(data: T): Node<T> {
            return collections.lookup(this._nodes, this._hashFn(data));
        }
    }

}

export module maps {
    /**
     * Type of objects whose values are all of the same type.
     * The `in` and `for-in` operators can *not* be safely used,
     * since `Object.prototype` may be modified by outside code.
     */
    export interface MapLike<T> {
        [index: string]: T;
    }

    /** ES6 Map interface, only read methods included. */
    export interface ReadonlyMap<T> {
        get(key: string): T | undefined;
        has(key: string): boolean;
        forEach(action: (value: T, key: string) => void): void;
        readonly size: number;
        keys(): Iterator<string>;
        values(): Iterator<T>;
        entries(): Iterator<[string, T]>;
    }

    /** ES6 Map interface. */
    export interface Map<T> extends ReadonlyMap<T> {
        set(key: string, value: T): this;
        delete(key: string): boolean;
        clear(): void;
    }

    /** ES6 Iterator type. */
    export interface Iterator<T> {
        next(): { value: T, done: false } | { value: never, done: true };
    }

    // The global Map object. This may not be available, so we must test for it.
    declare const Map: { new <T>(): Map<T> } | undefined;
    // Internet Explorer's Map doesn't support iteration, so don't use it.
    // tslint:disable-next-line:no-in-operator
    const MapCtr = typeof Map !== "undefined" && "entries" in Map.prototype ? Map : shimMap();

    // Keep the class inside a function so it doesn't get compiled if it's not used.
    function shimMap(): { new <T>(): Map<T> } {

        class MapIterator<T, U extends (string | T | [string, T])> {
            private data: MapLike<T>;
            private keys: ReadonlyArray<string>;
            private index = 0;
            private selector: (data: MapLike<T>, key: string) => U;
            constructor(data: MapLike<T>, selector: (data: MapLike<T>, key: string) => U) {
                this.data = data;
                this.selector = selector;
                this.keys = Object.keys(data);
            }

            public next(): { value: U, done: false } | { value: never, done: true } {
                const index = this.index;
                if (index < this.keys.length) {
                    this.index++;
                    return { value: this.selector(this.data, this.keys[index]), done: false };
                }
                return { value: undefined as never, done: true };
            }
        }

        return class <T> implements Map<T> {
            private data = createDictionaryObject<T>();
            public size = 0;

            get(key: string): T {
                return this.data[key];
            }

            set(key: string, value: T): this {
                if (!this.has(key)) {
                    this.size++;
                }
                this.data[key] = value;
                return this;
            }

            has(key: string): boolean {
                // tslint:disable-next-line:no-in-operator
                return key in this.data;
            }

            delete(key: string): boolean {
                if (this.has(key)) {
                    this.size--;
                    delete this.data[key];
                    return true;
                }
                return false;
            }

            clear(): void {
                this.data = createDictionaryObject<T>();
                this.size = 0;
            }

            keys() {
                return new MapIterator(this.data, (_data, key) => key);
            }

            values() {
                return new MapIterator(this.data, (data, key) => data[key]);
            }

            entries() {
                return new MapIterator(this.data, (data, key) => [key, data[key]] as [string, T]);
            }

            forEach(action: (value: T, key: string) => void): void {
                for (const key in this.data) {
                    action(this.data[key], key);
                }
            }
        };
    }

    /** Create a MapLike with good performance. */
    function createDictionaryObject<T>(): MapLike<T> {
        const map = Object.create(/*prototype*/ null); // tslint:disable-line:no-null-keyword

        // Using 'delete' on an object causes V8 to put the object in dictionary mode.
        // This disables creation of hidden classes, which are expensive when an object is
        // constantly changing shape.
        map["__"] = undefined;
        delete map["__"];

        return map;
    }

    /** Create a new map. If a template object is provided, the map will copy entries from it. */
    export function createMap<T>(): Map<T> {
        return new MapCtr<T>();
    }

    export interface MultiMap<T> extends Map<T[]> {
        /**
         * Adds the value to an array of values associated with the key, and returns the array.
         * Creates the array if it does not already exist.
         */
        add(key: string, value: T): T[];
        /**
         * Removes a value from an array of values associated with the key.
         * Does not preserve the order of those values.
         * Does nothing if `key` is not in `map`, or `value` is not in `map[key]`.
         */
        remove(key: string, value: T): void;
    }

    export function createMultiMap<T>(): MultiMap<T> {
        const map = createMap<T[]>() as MultiMap<T>;
        map.add = multiMapAdd;
        map.remove = multiMapRemove;
        return map;
    }
    function multiMapAdd<T>(this: MultiMap<T>, key: string, value: T) {
        let values = this.get(key);
        if (values) {
            values.push(value);
        }
        else {
            this.set(key, values = [value]);
        }
        return values;

    }
    function multiMapRemove<T>(this: MultiMap<T>, key: string, value: T) {
        const values = this.get(key);
        if (values) {
            unorderedRemoveItem(values, value);
            if (!values.length) {
                this.delete(key);
            }
        }
    }

    export function unorderedRemoveItem<T>(array: T[], item: T): boolean {
        for (let i = 0; i < array.length; i++) {
            if (array[i] === item) {
                // Fill in the "hole" left at `index`.
                array[i] = array[array.length - 1];
                array.pop();
                return true;
            }
        }
        return false;
    }

    /**
   * Calls `callback` for each entry in the map, returning the first truthy result.
   * Use `map.forEach` instead for normal iteration.
   */
    export function forEachEntry<T, U>(map: ReadonlyMap<T>, callback: (value: T, key: string) => U | undefined): U | undefined {
        const iterator = map.entries();
        for (let { value: pair, done } = iterator.next(); !done; { value: pair, done } = iterator.next()) {
            const [key, value] = pair;
            const result = callback(value, key);
            if (result) {
                return result;
            }
        }
        return undefined;
    }
}

export module misc {
    export function noop(): void { }
}