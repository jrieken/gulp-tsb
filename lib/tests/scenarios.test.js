"use strict";
var fs = require("fs");
var path = require("path");
var tsb = require("../");
var chai_1 = require("chai");
var chai_baseline_1 = require("chai-baseline");
chai_1.use(chai_baseline_1.chaiBaseline);
describe("scenario", function () {
    var testsdir = path.join(__dirname, "../../tests");
    var scenariosdir = path.join(testsdir, "scenarios");
    var baselinesdir = path.join(testsdir, "baselines");
    if (!fs.existsSync(scenariosdir)) {
        // no scenarios
        return;
    }
    var _loop_1 = function (name_1) {
        var scenariodir = path.join(scenariosdir, name_1);
        var build = path.join(scenariodir, "build.js");
        if (fs.existsSync(build)) {
            it(name_1, function (done) {
                var ended = false;
                var files = [];
                var participants = [];
                var scenario = require(build);
                var stream = scenario(tsb);
                stream.on("data", function (file) {
                    var basename = path.basename(file.relative);
                    var relativedir = path.normalize(path.dirname(file.relative))
                        .replace(/([\\/])\.($|[\\/])/g, "$1dot$2")
                        .replace(/(^|[\\/])\.\.($|[\\/])/g, "$1dotDot$2");
                    var relative = path.join(name_1, relativedir, basename);
                    files.push(path.normalize(path.join(relativedir, basename)));
                    participants.push(chai_1.assert.baseline(file.contents, path.join(name_1, relativedir, basename), { base: baselinesdir }));
                    if (file.sourceMap) {
                        files.push(path.normalize(path.join(relativedir, basename + ".sourceMap.txt")));
                        participants.push(chai_1.assert.baseline(normalizeLineEndings(JSON.stringify(file.sourceMap, undefined, "  ")), path.join(name_1, relativedir, basename) + ".sourceMap.txt", { base: baselinesdir }));
                    }
                });
                stream.on("error", done);
                stream.on("close", onend);
                stream.on("end", onend);
                function onend() {
                    if (ended)
                        return;
                    ended = true;
                    participants.push(chai_1.assert.baseline(normalizeLineEndings(JSON.stringify(files.sort(), undefined, "  ")), path.join(name_1, "files.json"), { base: baselinesdir }));
                    var waitOne = function () { return participants.length ? participants.shift().then(waitOne, done) : done(); };
                    waitOne();
                }
            });
        }
    };
    for (var _i = 0, _a = fs.readdirSync(scenariosdir); _i < _a.length; _i++) {
        var name_1 = _a[_i];
        _loop_1(name_1);
    }
});
function normalizeLineEndings(text) {
    return text.replace(/\r?\n/g, "\n");
}
