'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
var collections;
(function (collections) {
    var hasOwnProperty = Object.prototype.hasOwnProperty;
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
    function format(value) {
        var rest = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            rest[_i - 1] = arguments[_i];
        }
        return value.replace(/({\d+})/g, function (match) {
            var index = match.substring(1, match.length - 1);
            return rest[index] || match;
        });
    }
    strings.format = format;
})(strings = exports.strings || (exports.strings = {}));
var maps;
(function (maps) {
    // Internet Explorer's Map doesn't support iteration, so don't use it.
    // tslint:disable-next-line:no-in-operator
    var MapCtr = typeof Map !== "undefined" && "entries" in Map.prototype ? Map : shimMap();
    // Keep the class inside a function so it doesn't get compiled if it's not used.
    function shimMap() {
        var MapIterator = /** @class */ (function () {
            function MapIterator(data, selector) {
                this.index = 0;
                this.data = data;
                this.selector = selector;
                this.keys = Object.keys(data);
            }
            MapIterator.prototype.next = function () {
                var index = this.index;
                if (index < this.keys.length) {
                    this.index++;
                    return { value: this.selector(this.data, this.keys[index]), done: false };
                }
                return { value: undefined, done: true };
            };
            return MapIterator;
        }());
        return /** @class */ (function () {
            function class_1() {
                this.data = createDictionaryObject();
                this.size = 0;
            }
            class_1.prototype.get = function (key) {
                return this.data[key];
            };
            class_1.prototype.set = function (key, value) {
                if (!this.has(key)) {
                    this.size++;
                }
                this.data[key] = value;
                return this;
            };
            class_1.prototype.has = function (key) {
                // tslint:disable-next-line:no-in-operator
                return key in this.data;
            };
            class_1.prototype.delete = function (key) {
                if (this.has(key)) {
                    this.size--;
                    delete this.data[key];
                    return true;
                }
                return false;
            };
            class_1.prototype.clear = function () {
                this.data = createDictionaryObject();
                this.size = 0;
            };
            class_1.prototype.keys = function () {
                return new MapIterator(this.data, function (_data, key) { return key; });
            };
            class_1.prototype.values = function () {
                return new MapIterator(this.data, function (data, key) { return data[key]; });
            };
            class_1.prototype.entries = function () {
                return new MapIterator(this.data, function (data, key) { return [key, data[key]]; });
            };
            class_1.prototype.forEach = function (action) {
                for (var key in this.data) {
                    action(this.data[key], key);
                }
            };
            return class_1;
        }());
    }
    /** Create a MapLike with good performance. */
    function createDictionaryObject() {
        var map = Object.create(/*prototype*/ null); // tslint:disable-line:no-null-keyword
        // Using 'delete' on an object causes V8 to put the object in dictionary mode.
        // This disables creation of hidden classes, which are expensive when an object is
        // constantly changing shape.
        map["__"] = undefined;
        delete map["__"];
        return map;
    }
    /** Create a new map. If a template object is provided, the map will copy entries from it. */
    function createMap() {
        return new MapCtr();
    }
    maps.createMap = createMap;
    function createMultiMap() {
        var map = createMap();
        map.add = multiMapAdd;
        map.remove = multiMapRemove;
        return map;
    }
    maps.createMultiMap = createMultiMap;
    function createUniqueMultiMap() {
        var map = createMap();
        map.add = multiMapAddUnique;
        map.remove = multiMapRemove;
        return map;
    }
    maps.createUniqueMultiMap = createUniqueMultiMap;
    function multiMapAdd(key, value) {
        var values = this.get(key);
        if (values) {
            values.push(value);
        }
        else {
            this.set(key, values = [value]);
        }
        return values;
    }
    function multiMapAddUnique(key, value) {
        var values = this.get(key);
        if (values) {
            if (values.indexOf(value) === -1) {
                values.push(value);
            }
        }
        else {
            this.set(key, values = [value]);
        }
        return values;
    }
    function multiMapRemove(key, value) {
        var values = this.get(key);
        if (values) {
            unorderedRemoveItem(values, value);
            if (!values.length) {
                this.delete(key);
            }
        }
    }
    function unorderedRemoveItem(array, item) {
        for (var i = 0; i < array.length; i++) {
            if (array[i] === item) {
                // Fill in the "hole" left at `index`.
                array[i] = array[array.length - 1];
                array.pop();
                return true;
            }
        }
        return false;
    }
    maps.unorderedRemoveItem = unorderedRemoveItem;
    /**
   * Calls `callback` for each entry in the map, returning the first truthy result.
   * Use `map.forEach` instead for normal iteration.
   */
    function forEachEntry(map, callback) {
        var _a;
        var iterator = map.entries();
        for (var _b = iterator.next(), pair = _b.value, done = _b.done; !done; _a = iterator.next(), pair = _a.value, done = _a.done, _a) {
            var key = pair[0], value = pair[1];
            var result = callback(value, key);
            if (result) {
                return result;
            }
        }
        return undefined;
    }
    maps.forEachEntry = forEachEntry;
})(maps = exports.maps || (exports.maps = {}));
