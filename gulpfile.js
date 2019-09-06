
//@ts-check

const gulp = require('gulp');
const path = require('path');
const util = require('util');
const mocha = require('gulp-mocha');
const rimraf = require('rimraf');
const tsb = require('./lib');

const compilation = tsb.create('./tsconfig.json', {}, true);

const latest = [
    'lib-build/**/*.js',
    'lib-build/**/*.js.map',
    'lib-build/**/*.d.ts'
];

// build latest using LKG version
gulp.task('pre-build', function () {
    return compilation.src()
        .pipe(compilation())
        .pipe(gulp.dest('lib-prebuild'));
})

// re-build latest using built version
gulp.task('build', gulp.series('pre-build', function buildWithPreBuild() {
    var tsb = reload('./lib-prebuild');
    var compilation = tsb.create('./tsconfig.json', {}, /*verbose*/ true);
    return compilation.src()
        .pipe(compilation())
        .pipe(gulp.dest('lib-build'));
}));

// clean built versions
gulp.task('clean', function () {
    return Promise.all([
        util.promisify(rimraf)(path.join(__dirname, 'lib-build')),
        util.promisify(rimraf)(path.join(__dirname, 'lib-prebuild'))
    ]);
});

// copy files for 'lkg' task
gulp.task('lkg:copy', gulp.series(
    function clean() {
        return util.promisify(rimraf)(path.join(__dirname, 'lib'))
    },
    function copy() {
        return gulp.src(latest).pipe(gulp.dest('lib'));
    }
));

// deploy lkg
gulp.task('test', gulp.series('build', function _mocha() {
    return gulp.src(["lib-build/tests/**/*.js"], { read: false }).pipe(mocha({ timeout: 3000 }));
}));

gulp.task('lkg', gulp.series('clean', 'test', 'lkg:copy'));

// reload a node module and any children beneath the same folder
function reload(moduleName) {
    var id = require.resolve(moduleName);
    var mod = require.cache[id];
    if (mod) {
        var base = path.dirname(mod.filename);
        // expunge each module cache entry beneath this folder
        var stack = [mod];
        while (stack.length) {
            var mod = stack.pop();
            if (beneathBase(mod.filename)) {
                delete require.cache[mod.id];
            }
            stack.push.apply(stack, mod.children);
        }
    }

    // expunge each path cache entry beneath the folder
    // @ts-ignore
    for (var cacheKey in module.constructor._pathCache) {
        if (cacheKey.indexOf(moduleName) > 0 && beneathBase(cacheKey)) {
            // @ts-ignore
            delete module.constructor._pathCache[cacheKey];
        }
    }

    // re-require the module
    return require(moduleName);

    function beneathBase(file) {
        return base === undefined
            || (file.length > base.length
                && file.substr(0, base.length + 1) === base + path.sep);
    }
}
