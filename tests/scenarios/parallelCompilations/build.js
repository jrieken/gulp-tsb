var path = require("path");
var EventEmitter = require("events").EventEmitter;
module.exports = function (tsb) {
    var projectA = tsb.create(path.resolve(__dirname, "./a/tsconfig.json"), { parallel: true, verbose: true });
    var projectB = tsb.create(path.resolve(__dirname, "./b/tsconfig.json"), { parallel: true, verbose: true });
    var emitter = new EventEmitter();

    projectA.src()
        .pipe(projectA())
        .on("data", function(data) { emitter.emit("data", data) })
        .on("error", function(err) { emitter.emit("error", err) })
        .on("end", addEnd)
        .on("close", addClose);

    projectB.src()
        .pipe(projectB())
        .on("data", function(data) { emitter.emit("data", data) })
        .on("error", function(err) { emitter.emit("error", err) })
        .on("end", addEnd)
        .on("close", addClose);

    var endings = 0;
    var closings = 0;
    function addEnd() {
        endings++;
        if (endings === 2) {
            emitter.emit("end");
        }
    }

    function addClose() {
        closings++;
        if (closings === 2) {
            emitter.emit("close");
        }
    }
    return emitter;
};