/* global __dirname */

var gulp = require('gulp');
var path = require('path');
var mocha = require('gulp-mocha');
var del = require("del");
var tsb = require('./lib');
var compilation = tsb.create('.');

// build using lkg version
gulp.task('pre-build', function() {
	return compilation.src()
		.pipe(compilation())
		.pipe(compilation.dest());
});

// build using built version
gulp.task('build', ['pre-build'], function() {
	var tsb = reload("./out");
	var compilation = tsb.create('.', { verbose: true });
	return compilation.src()
		.pipe(compilation())
		.pipe(compilation.dest());
});

// clean built version
gulp.task('clean', function (cb) {
	del("out", cb);
});

// accept local test baselines
gulp.task('accept-baselines', function () {
	return gulp.src("tests/baselines/local/**/*")
		.pipe(gulp.dest("tests/baselines/reference"));
});

// clean local test baselines
gulp.task('clean-local-baselines', function (cb) {
	del(["tests/baselines/local"])
		.then(function() { return cb() }, function(e) { return cb(e) });
});

// run tests
gulp.task('test', ['build', 'clean-local-baselines'], function() {
	return gulp.src(["out/tests/**/*.js"], { read: false })
		.pipe(mocha({ timeout: 3000 }));
});

// accept built version as lkg
gulp.task('lkg', ['test'], function() {
	return gulp.src(["out/**/*.js", "out/**/*.d.ts", "!out/tests/scenarios.test.*"])
		.pipe(gulp.dest("lib"));
});

gulp.task('dev', ['test'], function() {
    gulp.watch(["src/**/*.ts"], ['test']);
});

gulp.task('default', ['dev']);

// reload a node module and any children beneath the same folder
function reload(moduleName) {
	var id = require.resolve(moduleName);
	var mod = require.cache[id];
	if (mod) {
		var base = path.dirname(mod.filename);
		var stack = [mod];
		while (stack.length) {
			var mod = stack.pop();
			if (beneathBase(mod.filename)) {
				delete require.cache[mod.id];
			}
			stack.push.apply(stack, mod.children);
		}
	}

	for (var cacheKey in module.constructor._pathCache) {
		if (cacheKey.indexOf(moduleName) > 0 && beneathBase(cacheKey)) {
			delete module.constructor._pathCache[cacheKey];
		}
	}

	return require(moduleName);

	function beneathBase(file) {
		return base === undefined
			|| (file.length > base.length
				&& file.substr(0, base.length + 1) === base + path.sep);
	}
}
