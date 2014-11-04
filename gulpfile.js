
var gulp = require('gulp');
var tsb = require('./lib/src');

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

gulp.task('pre_release', function() { 
	target = 'lib';
});

gulp.task('post_release', function() { 
	target = '/';
});

gulp.task('release', ['pre_release', 'build', 'post_release'], function() { 
	gulp.src('src/typescript/**.*')
		.pipe(gulp.dest('lib/src/typescript'));	
});


gulp.task('dev', ['build'], function() {
    gulp.watch(sources, ['build']);
});

gulp.task('default', ['dev']);