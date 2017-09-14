/* global __dirname */

var gulp = require('gulp');
var util = require('gulp-util');
var path = require('path');
var child_process = require('child_process');
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

gulp.task('accept-baselines', function () {
    return gulp.src(["tests/baselines/local/**/*"])
        .pipe(gulp.dest("tests/baselines/reference"));
});

gulp.task('clean-local-baselines', function () {
    return del(["tests/baselines/local"]);
});

gulp.task('test', ['build', 'clean-local-baselines'], function () {
    return gulp.src(["out/tests/**/*.js"], { read: false })
        .pipe(mocha({ timeout: 3000 }));
});

gulp.task('diff', function (cb) {
    getDiffTool(function (e, tool) {
        if (e) return cb(e);
        tool = formatDiffTool(tool, "tests/baselines/reference", "tests/baselines/local");
        util.log(tool);
        var args = parseCommand(tool);
        child_process.spawn(args.shift(), args, { detached: true }).unref();
        cb(null);
    });
});

gulp.task('dev', ['test'], function () {
    return gulp.watch(sources, ['test']);
});

gulp.task('default', ['dev']);

// get the diff tool either from the 'DIFF' environment variable or from git
function getDiffTool(cb) {
    var difftool = process.env['DIFF'];
    if (difftool) return cb(null, difftool);
    child_process.exec('git config diff.tool', function (e, stdout) {
        if (e) return cb(e, null);
        if (stdout) stdout = stdout.trim();
        if (!stdout) return cb(new Error("Add the 'DIFF' environment variable to the path of the program you want to use."), null);
        child_process.exec('git config difftool.' + stdout + '.cmd', function (e, stdout) {
            if (e) return cb(e, null);
            if (stdout) stdout = stdout.trim();
            if (!stdout) return cb(new Error("Add the 'DIFF' environment variable to the path of the program you want to use."), null);
            return cb(null, stdout);
        });
    });
}

// format the diff tool path with a left and right comparison path
function formatDiffTool(toolPath, leftPath, rightPath) {
    return /\$(local|remote)/i.test(toolPath)
        ? toolPath.replace(/(\$local)|(\$remote)/gi, function (_, left, right) { return left ? leftPath : rightPath; })
        : '"' + toolPath + '" "' + leftPath + '" "' + rightPath + '"';
}

// parse a command line string
function parseCommand(text) {
    var re = /"([^"]*)"|[^"\s]+/g, args = [], m;
    while (m = re.exec(text)) args.push(m[1] || m[0]);
    return args;
}

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
