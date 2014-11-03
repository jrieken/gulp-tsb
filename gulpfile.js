/// <reference path="typings/node/node.d.ts" />

var gulp = require('gulp');
var ts = require('gulp-typescript');

var tsProject = ts.createProject({
    declarationFiles: false,
    noExternalResolve: true,
	module: 'commonjs',
	target: 'es5'
});

gulp.task('scripts', function() {
    var tsResult = gulp.src([
		'lib/**/*.ts',
		'typings/**/*.ts',
		'!lib/typescript/lib*.ts'
		]).pipe(ts(tsProject));

	tsResult.js.pipe(gulp.dest('lib'));
});

gulp.task('watch', ['scripts'], function() {
    gulp.watch('lib/*.ts', ['scripts']);
});

gulp.task('default', ['scripts', 'watch']);


var tsb = require('./lib');

var compilation = tsb.create({
	verbose: true,
	target: 'es5',
	module: 'commonjs'
});

gulp.task('scripts2', function() {
	
	gulp.src([
		'lib/**/*.ts',
		'typings/**/*.ts',
		'!lib/typescript/lib*.ts'
	])
	.pipe(compilation())
	.pipe(gulp.dest('lib-alt'));
});

gulp.task('watch2', ['scripts2'], function() {
    gulp.watch('lib/*.ts', ['scripts2']);
});
