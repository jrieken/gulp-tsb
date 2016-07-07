/* global __dirname */

var gulp = require('gulp');
var path = require('path');
var tsb = require('./');
var compilation = tsb.create('.', true);

gulp.task('build', function() {
	return compilation.src()
		.pipe(compilation())
		.pipe(compilation.dest());
});

gulp.task('dev', ['build'], function() {
    gulp.watch(sources, ['build']);
});

gulp.task('default', ['dev']);
