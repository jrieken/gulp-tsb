/* global __dirname */

var gulp = require('gulp');
var path = require('path');
var tsb = require('./src');

var compilation = tsb.create(path.join(__dirname, 'tsconfig.json'), true);

var sources = [
	'src/**/*.ts',
	'typings/**/*.ts',
	'!src/typescript/lib*.ts'
];

var target = '';

gulp.task('build', function() {
	return gulp.src(sources)
		.pipe(compilation())
		.pipe(gulp.dest(target));
});

gulp.task('dev', ['build'], function() {
    gulp.watch(sources, ['build']);
});

gulp.task('default', ['dev']);