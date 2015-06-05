'use strict';
var index = require('../index');
var assert = require('assert');
describe('options - test that', function () {
    it('does not change the config object', function () {
        var config = {
            json: true,
            verbose: true
        };
        Object.freeze(config);
        index.create(config);
        assert.equal(Object.keys(config).length, 2);
    });
});
