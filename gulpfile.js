
var gulp = require('gulp');
var path = require('path');
var util = require('util');
var mocha = require('gulp-mocha');
var rimraf = require('rimraf');
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
gulp.task('pre-build', function () {
    return gulp.src(sources)
        .pipe(compilation())
        .pipe(gulp.dest('tmp'));
})

// re-build latest using built version
gulp.task('build', gulp.series('pre-build', function () {
    var tsb = reload('./tmp');
    var compilation = tsb.create('./tsconfig.json', /*verbose*/ true);
    return gulp.src(sources)
        .pipe(compilation())
        .pipe(gulp.dest('out'));
}));

// clean built versions
gulp.task('clean', function () {
    return Promise.all([
        util.promisify(rimraf)(path.join(__dirname, 'tmp')),
        util.promisify(rimraf)(path.join(__dirname, 'out'))
    ]);
});

// clean the lkg
gulp.task('lkg:clean', function () {
    return util.promisify(rimraf)(path.join(__dirname, 'lib'))
});

// copy files for 'lkg' task
gulp.task('lkg:copy', gulp.series('lkg:clean', function () {
    return gulp.src(latest).pipe(gulp.dest('lib'));
}));

// deploy lkg

gulp.task('test', gulp.series('build', function () {
    return gulp.src(["out/tests/**/*.js"], { read: false })
        .pipe(mocha({ timeout: 3000 }));
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
