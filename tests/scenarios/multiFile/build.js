var vfs = require("vinyl-fs");
var stream = require("stream");
module.exports = function (tsb) {
    var build = tsb.create({
        module: "commonjs",
        target: "es5",
        declaration: true,
        sourceMap: true,
        newLine: "lf"
    }, { base: __dirname });
    return vfs
        .src("**/*.ts", { cwd: __dirname })
        .pipe(build());
};