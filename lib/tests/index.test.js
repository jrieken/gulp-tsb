'use strict';
var index = require("../index");
var assert = require("assert");
describe('options - test that', function () {
    it('does not change the config object', function () {
        var config = {
            json: true,
            verbose: true,
            noFilesystemLookup: true
        };
        Object.freeze(config);
        index.create(config);
        assert.equal(Object.keys(config).length, 3);
    });
    it('keeps allowJs', function () {
        var compiler = index.create({ allowJs: true });
        assert.equal(compiler.program.getCompilerOptions().allowJs, true);
        compiler = index.create({ allowJs: false });
        assert.equal(compiler.program.getCompilerOptions().allowJs, false);
        compiler = index.create({});
        assert.equal(compiler.program.getCompilerOptions().allowJs, undefined);
    });
});
