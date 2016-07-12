var vfs = require("vinyl-fs");
module.exports = function (tsb) {
    var build = tsb.create({
        module: "commonjs",
        target: "es5",
        declaration: true,
        sourceMap: true
    });
    return vfs
        .src("**/*.ts", { cwd: __dirname })
        .pipe(build());
};