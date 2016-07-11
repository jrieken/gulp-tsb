/* global __dirname */

var gulp = require('gulp');
var path = require('path');
var tsb = require('./lib');
var compilation = tsb.create('.', { verbose: true });

gulp.task('build', function() {
	return compilation.src()
		.on("data", data => console.log(data.relative))
		.pipe(compilation())
		.pipe(compilation.dest());
});

gulp.task('lkg', function() {
	return gulp.src(["out/**/*.js", "out/**/*.d.ts"])
		.pipe(gulp.dest("lib"));
});

gulp.task('dev', ['build'], function() {
    gulp.watch(["src/**/*.ts"], ['build']);
});

gulp.task('default', ['dev']);
