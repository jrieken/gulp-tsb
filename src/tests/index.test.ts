'use strict';

import index = require('../index');
import assert = require('assert');

describe('options - test that', function () {
    function verifyOptions(ignoreWatchApi: boolean) {
        it('does not change the config object', function () {

            var config: { [option: string]: string | number | boolean; } = {
                json: true,
                verbose: true,
                noFilesystemLookup: true,
                ignoreWatchApi
            };

            Object.freeze(config);
            index.create(config);

            assert.equal(Object.keys(config).length, 4);

        });

        it('keeps allowJs', function () {

            let compiler = index.create({ allowJs: true, ignoreWatchApi });
            assert.equal(compiler.program.getCompilerOptions().allowJs, true);

            compiler = index.create({ allowJs: false, ignoreWatchApi });
            assert.equal(compiler.program.getCompilerOptions().allowJs, false);

            compiler = index.create({ ignoreWatchApi });
            assert.equal(compiler.program.getCompilerOptions().allowJs, undefined);
        });
    }

    describe("With Language service API", () => {
        return verifyOptions(/*ignoreWatchApi*/ true);
    });

    describe("With watch API", () => {
        return verifyOptions(/*ignoreWatchApi*/ false);
    });
});