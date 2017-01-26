/* global __dirname */

var gulp = require('gulp');
var path = require('path');
var mocha = require('gulp-mocha');
var del = require('del');
var runSequence = require('run-sequence');
var tsb = require('./lib');
var compilation = tsb.create('./tsconfig.json', /*verbose*/ true);

var sources = [
    'src/**/*.ts',
    'node_modules/@types/**/*.ts'
];

var latest = [
    'out/**/*.js',
    'out/**/*.js.map',
    'out/**/*.d.ts'
];

// build latest using LKG version
gulp.task('pre-build', function() {
    return gulp.src(sources)
        .pipe(compilation())
        .pipe(gulp.dest('tmp'));
})

// re-build latest using built version
gulp.task('build', ['pre-build'], function () {
    var tsb = reload('./tmp');
    var compilation = tsb.create('./tsconfig.json', /*verbose*/ true);
    return gulp.src(sources)
        .pipe(compilation())
        .pipe(gulp.dest('out'));
});

// clean built versions
gulp.task('clean', function () {
    return del(['tmp', 'out']);
});

// clean the lkg
gulp.task('lkg:clean', function () {
    return del(['lib']);
});

// copy files for 'lkg' task
gulp.task('lkg:copy', ['lkg:clean'], function () {
    return gulp.src(latest).pipe(gulp.dest('lib'));
});

// deploy lkg
gulp.task('lkg', function () {
    return runSequence('clean', 'test', 'lkg:copy');
});

gulp.task('test', ['build'], function () {
    return gulp.src(["out/tests/**/*.js"], { read: false })
        .pipe(mocha({ timeout: 3000 }));
});

gulp.task('dev', ['test'], function () {
    return gulp.watch(sources, ['test']);
});

gulp.task('default', ['dev']);

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
    for (var cacheKey in module.constructor._pathCache) {
        if (cacheKey.indexOf(moduleName) > 0 && beneathBase(cacheKey)) {
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
