var vfs = require("vinyl-fs");
var sourcemaps = require("gulp-sourcemaps");
var stream = require("stream");
module.exports = function (tsb) {
    var build = tsb.create({
        module: "commonjs",
        target: "es5",
        declaration: true,
        sourceMap: true,
        outFile: "c.js",
        newLine: "lf"
    });
    return vfs
        .src("**/*.ts", { cwd: __dirname })
        .pipe(sourcemaps.init())
        .pipe(build());
};