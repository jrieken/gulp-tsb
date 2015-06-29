'use strict';
var utils = require('../utils');
var assert = require('assert');
describe('graph - test that', function () {
    var graph;
    beforeEach(function () {
        graph = new utils.graph.Graph(function (s) { return s; });
    });
    it('cannot be traversed when empty', function () {
        graph.traverse('foo', true, function () { return assert.ok(false); });
        graph.traverse('foo', false, function () { return assert.ok(false); });
        assert.ok(true);
    });
    it('is possible to lookup nodes that don\'t exist', function () {
        assert.deepEqual(graph.lookup('ddd'), null);
    });
    it('inserts nodes when not there yet', function () {
        assert.deepEqual(graph.lookup('ddd'), null);
        assert.deepEqual(graph.lookupOrInsertNode('ddd').data, 'ddd');
        assert.deepEqual(graph.lookup('ddd').data, 'ddd');
    });
    it('can remove nodes', function () {
        assert.deepEqual(graph.lookup('ddd'), null);
        assert.deepEqual(graph.lookupOrInsertNode('ddd').data, 'ddd');
        graph.removeNode('ddd');
        assert.deepEqual(graph.lookup('ddd'), null);
    });
    it('traverse from leaf', function () {
        graph.inertEdge('foo', 'bar');
        graph.traverse('bar', true, function (node) { return assert.equal(node, 'bar'); });
        var items = ['bar', 'foo'];
        graph.traverse('bar', false, function (node) { return assert.equal(node, items.shift()); });
    });
    it('traverse from center', function () {
        graph.inertEdge('1', '3');
        graph.inertEdge('2', '3');
        graph.inertEdge('3', '4');
        graph.inertEdge('3', '5');
        var items = ['3', '4', '5'];
        graph.traverse('3', true, function (node) { return assert.equal(node, items.shift()); });
        var items = ['3', '1', '2'];
        graph.traverse('3', false, function (node) { return assert.equal(node, items.shift()); });
    });
    it('traverse a chain', function () {
        graph.inertEdge('1', '2');
        graph.inertEdge('2', '3');
        graph.inertEdge('3', '4');
        graph.inertEdge('4', '5');
        var items = ['1', '2', '3', '4', '5'];
        graph.traverse('1', true, function (node) { return assert.equal(node, items.shift()); });
        var items = ['1', '2', '3', '4', '5'].reverse();
        graph.traverse('5', false, function (node) { return assert.equal(node, items.shift()); });
    });
});
