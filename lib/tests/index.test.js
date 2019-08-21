'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
var index = require("../index");
var assert = require("assert");
describe('options - test that', function () {
    function verifyOptions(ignoreWatchApi) {
        it('does not change the config object', function () {
            var config = {
                json: true,
                verbose: true,
                noFilesystemLookup: true,
                ignoreWatchApi: ignoreWatchApi
            };
            Object.freeze(config);
            index.create(config);
            assert.equal(Object.keys(config).length, 4);
        });
        it('keeps allowJs', function () {
            var compiler = index.create({ allowJs: true, ignoreWatchApi: ignoreWatchApi });
            assert.equal(compiler.program.getCompilerOptions().allowJs, true);
            compiler = index.create({ allowJs: false, ignoreWatchApi: ignoreWatchApi });
            assert.equal(compiler.program.getCompilerOptions().allowJs, false);
            compiler = index.create({ ignoreWatchApi: ignoreWatchApi });
            assert.equal(compiler.program.getCompilerOptions().allowJs, undefined);
        });
    }
    describe("With Language service API", function () {
        return verifyOptions(/*ignoreWatchApi*/ true);
    });
    describe("With watch API", function () {
        return verifyOptions(/*ignoreWatchApi*/ false);
    });
});
