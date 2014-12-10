
var gulp = require('gulp');
var tsb = require('./src');

var compilation = tsb.create({
	verbose: true,
	target: 'es5',
	module: 'commonjs'
});

var sources = [
	'src/**/*.ts',
	'typings/**/*.ts',
	'!src/typescript/lib*.ts'
];

var target = '/';

gulp.task('build', function() {
	return gulp.src(sources)
		.pipe(compilation())
		.pipe(gulp.dest(target));
});

gulp.task('dev', ['build'], function() {
    gulp.watch(sources, ['build']);
});

gulp.task('default', ['dev']);