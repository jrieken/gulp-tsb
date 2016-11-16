"use strict";
var Vinyl = require("vinyl");
var collections;
(function (collections) {
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function lookup(collection, key) {
        if (hasOwnProperty.call(collection, key)) {
            return collection[key];
        }
        return null;
    }
    collections.lookup = lookup;
    function insert(collection, key, value) {
        collection[key] = value;
    }
    collections.insert = insert;
    function lookupOrInsert(collection, key, value) {
        if (hasOwnProperty.call(collection, key)) {
            return collection[key];
        }
        else {
            collection[key] = value;
            return value;
        }
    }
    collections.lookupOrInsert = lookupOrInsert;
    function forEach(collection, callback) {
        for (var key in collection) {
            if (hasOwnProperty.call(collection, key)) {
                callback({
                    key: key,
                    value: collection[key]
                });
            }
        }
    }
    collections.forEach = forEach;
    function contains(collection, key) {
        return hasOwnProperty.call(collection, key);
    }
    collections.contains = contains;
    function structuredClone(value) {
        return structuredCloneRecursive(value, new Map());
    }
    collections.structuredClone = structuredClone;
    function structuredCloneRecursive(value, objects) {
        if (value === undefined)
            return undefined;
        if (value === null)
            return null;
        if (typeof value !== "object")
            return value;
        var clone = objects.get(value);
        if (clone === undefined) {
            clone = Array.isArray(value) ? Array(value.length) : {};
            objects.set(value, clone);
            for (var key in value) {
                if (contains(value, key)) {
                    clone[key] = structuredCloneRecursive(value[key], objects);
                }
            }
        }
        return clone;
    }
})(collections = exports.collections || (exports.collections = {}));
var strings;
(function (strings) {
    /**
     * The empty string. The one and only.
     */
    strings.empty = '';
    strings.eolUnix = '\r\n';
    function format(value) {
        var rest = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            rest[_i - 1] = arguments[_i];
        }
        return value.replace(/({\d+})/g, function (match) {
            var index = match.substring(1, match.length - 1);
            return rest[+index] || match;
        });
    }
    strings.format = format;
    function equal(left, right, ignoreCase) {
        return ignoreCase
            ? left.toUpperCase() === right.toUpperCase()
            : left === right;
    }
    strings.equal = equal;
})(strings = exports.strings || (exports.strings = {}));
var graph;
(function (graph) {
    function newNode(data) {
        return {
            data: data,
            incoming: {},
            outgoing: {}
        };
    }
    graph.newNode = newNode;
    var Graph = (function () {
        function Graph(_hashFn) {
            this._hashFn = _hashFn;
            this._nodes = {};
            // empty
        }
        Graph.prototype.traverse = function (start, inwards, callback) {
            var startNode = this.lookup(start);
            if (!startNode) {
                return;
            }
            this._traverse(startNode, inwards, {}, callback);
        };
        Graph.prototype._traverse = function (node, inwards, seen, callback) {
            var _this = this;
            var key = this._hashFn(node.data);
            if (collections.contains(seen, key)) {
                return;
            }
            seen[key] = true;
            callback(node.data);
            var nodes = inwards ? node.outgoing : node.incoming;
            collections.forEach(nodes, function (entry) { return _this._traverse(entry.value, inwards, seen, callback); });
        };
        Graph.prototype.inertEdge = function (from, to) {
            var fromNode = this.lookupOrInsertNode(from), toNode = this.lookupOrInsertNode(to);
            fromNode.outgoing[this._hashFn(to)] = toNode;
            toNode.incoming[this._hashFn(from)] = fromNode;
        };
        Graph.prototype.removeNode = function (data) {
            var key = this._hashFn(data);
            delete this._nodes[key];
            collections.forEach(this._nodes, function (entry) {
                delete entry.value.outgoing[key];
                delete entry.value.incoming[key];
            });
        };
        Graph.prototype.lookupOrInsertNode = function (data) {
            var key = this._hashFn(data), node = collections.lookup(this._nodes, key);
            if (!node) {
                node = newNode(data);
                this._nodes[key] = node;
            }
            return node;
        };
        Graph.prototype.lookup = function (data) {
            return collections.lookup(this._nodes, this._hashFn(data));
        };
        return Graph;
    }());
    graph.Graph = Graph;
})(graph = exports.graph || (exports.graph = {}));
function deserializeVinyl(file) {
    // Rehydrate a bunch of things that got stringified/mangled when converted to json for IPC
    var statsLookalike = {};
    var _loop_1 = function (key) {
        var _a = file.stat[key], kind = _a.kind, value = _a.value;
        if (kind === 'method') {
            statsLookalike[key] = function () { return value; };
        }
        else if (kind === 'date') {
            statsLookalike[key] = new Date(value);
        }
        else {
            statsLookalike[key] = value;
        }
    };
    for (var key in file.stat) {
        _loop_1(key);
    }
    var args = {
        cwd: file.cwd,
        contents: new Buffer(file.contents),
        base: file.base,
        history: file.history.slice(),
        stat: statsLookalike
    };
    var newFile = new Vinyl(args);
    newFile.sourceMap = file.sourceMap;
    return newFile;
}
exports.deserializeVinyl = deserializeVinyl;
function serializeVinyl(file) {
    var serialized = {
        cwd: file.cwd,
        base: file.base,
        history: file.history,
        stat: {},
        sourceMap: file.sourceMap,
        contents: file.contents.toString()
    };
    var iterableStat = file.stat;
    for (var key in iterableStat) {
        if (typeof iterableStat[key] === 'function') {
            serialized.stat[key] = { kind: 'method', value: iterableStat[key]() };
        }
        else if (iterableStat[key] instanceof Date) {
            serialized.stat[key] = { kind: 'date', value: +iterableStat[key] };
        }
        else {
            serialized.stat[key] = { kind: typeof iterableStat[key], value: iterableStat[key] };
        }
    }
    return serialized;
}
exports.serializeVinyl = serializeVinyl;
//# sourceMappingURL=utils.js.map
