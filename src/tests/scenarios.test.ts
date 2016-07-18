import * as fs from "fs";
import * as path from "path";
import * as events from "events";
import * as tsb from "../";
import { use, assert } from "chai";
import { chaiBaseline } from "chai-baseline";
import File = require("vinyl");

use(chaiBaseline);

describe("scenario", () => {
    const testsdir = path.join(__dirname, "../../tests");
    const baselinesdir = path.join(testsdir, "baselines");
    const scenariosdir = path.join(testsdir, "scenarios");
    for (const name of fs.readdirSync(scenariosdir)) {
        const scenariodir = path.join(scenariosdir, name);
        const build = path.join(scenariodir, "build.js");
        if (fs.existsSync(build)) {
            it(name, (done) => {
                let ended = false;
                const files: string[] = [];
                const participants: PromiseLike<void>[] = [];
                const scenario = require(build) as (tsb_: typeof tsb) => events.EventEmitter;
                const stream = scenario(tsb);
                stream.on("data", (file: File & { sourceMap?: any }) => {
                    const basename = path.basename(file.relative);
                    const relativedir = path.normalize(path.dirname(file.relative))
                        .replace(/([\\/])\.($|[\\/])/g, "$1dot$2")
                        .replace(/(^|[\\/])\.\.($|[\\/])/g, "$1dotDot$2");
                    files.push(path.normalize(path.join(relativedir, basename)));
                    participants.push(assert.baseline(file.contents, path.join(name, relativedir, basename), { base: baselinesdir }));
                    if (file.sourceMap) {
                        files.push(path.normalize(path.join(relativedir, basename + ".sourceMap.txt")));
                        participants.push(assert.baseline(normalizeLineEndings(JSON.stringify(file.sourceMap, undefined, "  ")), path.join(name, relativedir, basename) + ".sourceMap.txt", { base: baselinesdir }));
                    }
                });
                stream.on("error", done);
                stream.on("close", onend);
                stream.on("end", onend);

                function onend() {
                    if (ended) return;
                    ended = true;
                    participants.push(assert.baseline(normalizeLineEndings(JSON.stringify(files.sort(), undefined, "  ")), path.join(name, "files.json"), { base: baselinesdir }));
                    waitOne();

                    function waitOne(): void {
                        if (participants.length) {
                            participants.shift()!.then(waitOne, done);
                        }
                        else {
                            done();
                        }
                    }
                }
            });
        }
    }
});


function normalizeLineEndings(text: string) {
    return text.replace(/\r?\n/g, "\n");
}