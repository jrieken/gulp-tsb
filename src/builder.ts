/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/vinyl/vinyl.d.ts" />
/// <reference path="../typings/gulp-util/gulp-util.d.ts" />

'use strict';

import fs = require('fs');
import path = require('path');
import crypto = require('crypto');
import utils = require('./utils');
import gutil = require('gulp-util');
import ts = require('./typescript/typescriptServices');
import Vinyl = require('vinyl');

export interface IConfiguration {
	json: boolean;
	verbose: boolean;
	[option: string]: string | number | boolean;
}

export interface ITypeScriptBuilder {
	build(out: (file: Vinyl) => void, onError: (err: any) => void): void;
	file(file: Vinyl): void;
}

export function createTypeScriptBuilder(config: IConfiguration): ITypeScriptBuilder {

	var settings = createCompilationSettings(config),
		host = new LanguageServiceHost(settings),
		service = ts.createLanguageService(host, ts.createDocumentRegistry()),
		lastBuildVersion: { [path: string]: string } = Object.create(null),
		lastDtsHash: { [path: string]: string } = Object.create(null),
		userWantsDeclarations = settings.declaration,
		oldErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null),
		headUsed = process.memoryUsage().heapUsed;
		
	// always emit declaraction files
	host.getCompilationSettings().declaration = true;
	
	if (!host.getCompilationSettings().noLib) {
		var defaultLib = host.getDefaultLibFilename();
		host.addScriptSnapshot(defaultLib, new ScriptSnapshot(fs.readFileSync(defaultLib), fs.statSync(defaultLib)));
	}
	
	function log(topic: string, message: string): void { 
		if(config.verbose) {
			gutil.log(gutil.colors.cyan(topic), message);
		}
	}
	
	function printDiagnostic(diag: ts.Diagnostic, onError: (err: any) => void): void {

		var lineAndCh = diag.file.getLineAndCharacterFromPosition(diag.start),
			message: string;

		if (!config.json) {
			message = utils.strings.format('{0}({1},{2}): {3}',
				diag.file.filename,
				lineAndCh.line,
				lineAndCh.character,
				diag.messageText);

		} else {
			message = JSON.stringify({
				filename: diag.file.filename,
				offset: diag.start,
				length: diag.length,
				message: diag.messageText
			});
		}

		onError(message);
	}

	function file(file: Vinyl): void {
		var snapshot = new ScriptSnapshot(file.contents, file.stat);
		host.addScriptSnapshot(file.path, snapshot);
	}

	function build(out: (file: Vinyl) => void, onError: (err: any) => void): void {

		var filenames = host.getScriptFileNames(),
			newErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null),
			checkedThisRound: { [path: string]: boolean } = Object.create(null),
			filesWithShapeChanges: string[] = [],
			t1 = Date.now();
		
		function shouldCheck(filename: string): boolean {
			if (checkedThisRound[filename]) {
				return false;
			} else {
				checkedThisRound[filename] = true;
				return true;
			}
		}
		
		for (var i = 0, len = filenames.length; i < len; i++) {

			var filename = filenames[i],
				version = host.getScriptVersion(filename);

			if (lastBuildVersion[filename] === version) {
				// unchanged since the last time
				continue;
			}

			var output = service.getEmitOutput(filename),
				checkSyntax = false,
				checkSemantics = false,
				dtsHash: string = undefined;
			
			// emit output has fast as possible
			output.outputFiles.forEach(file => {

				if (/\.d\.ts$/.test(file.name)) {

					dtsHash = crypto.createHash('md5')
						.update(file.text)
						.digest('base64');

					if (!userWantsDeclarations) {
						// don't leak .d.ts files if users don't want them
						return;
					}
				}
				
				log('[emit output]', file.name);
				
				out(new Vinyl({
					path: file.name,
					contents: new Buffer(file.text)
				}));
			});
			
			// make use of emit status
			switch (output.emitOutputStatus) {
				case ts.EmitReturnStatus.Succeeded:
					// good
					break;
				case ts.EmitReturnStatus.AllOutputGenerationSkipped:
					log('[syntax errors]', filename);
					checkSyntax = true;
					break;
				case ts.EmitReturnStatus.JSGeneratedWithSemanticErrors:
				case ts.EmitReturnStatus.DeclarationGenerationSkipped:
					log('[semantic errors]', filename);
					checkSemantics = true;
					break;
				case ts.EmitReturnStatus.EmitErrorsEncountered:
				case ts.EmitReturnStatus.CompilerOptionsErrors:
				default:
					// don't really know what to do with these
					checkSyntax = true;
					checkSemantics = true;
					break;
			}
			
			// print and store syntax and semantic errors
			delete oldErrors[filename];
			var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []);
			if (checkSyntax) {
				diagnostics.push.apply(diagnostics, service.getSyntacticDiagnostics(filename));
			}
			if (checkSemantics) {
				diagnostics.push.apply(diagnostics, service.getSemanticDiagnostics(filename));
			}
			diagnostics.forEach(diag => {
				printDiagnostic(diag, onError);
			});
			
			// dts comparing
			if (dtsHash && lastDtsHash[filename] !== dtsHash) {
				lastDtsHash[filename] = dtsHash;
				if (service.getSourceFile(filename).externalModuleIndicator) {
					filesWithShapeChanges.push(filename);
				} else {
					filesWithShapeChanges.unshift(filename);
				}
			}

			lastBuildVersion[filename] = version;
			checkedThisRound[filename] = true;
		}
		
		if (filesWithShapeChanges.length === 0) {
			// nothing to do here
			
		} else if (!service.getSourceFile(filesWithShapeChanges[0]).externalModuleIndicator) {
			// at least one internal module changes which means that
			// we have to type check all others
			log('[shape changes]', 'internal module changed → FULL check required');
			host.getScriptFileNames().forEach(filename => {
				if(!shouldCheck(filename)) {
					return;
				}
				log('[semantic check*]', filename);
				var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []);
				service.getSemanticDiagnostics(filename).forEach(diag => {
					diagnostics.push(diag);
					printDiagnostic(diag, onError);
				});
			});
		} else {
			// reverse dependencies
			log('[shape changes]', 'external module changed → check REVERSE dependencies');
			var needsSemanticCheck: string[] = [];
			filesWithShapeChanges.forEach(filename => host.collectDependents(filename, needsSemanticCheck));
			while(needsSemanticCheck.length) {
				var filename = needsSemanticCheck.pop();
				if(!shouldCheck(filename)) {
					continue;
				}
				log('[semantic check*]', filename);
				var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []),
					hasSemanticErrors = false;
					
				service.getSemanticDiagnostics(filename).forEach(diag => {
					diagnostics.push(diag);
					printDiagnostic(diag, onError);
					hasSemanticErrors = true;
				});
				
				if(!hasSemanticErrors) {
					host.collectDependents(filename, needsSemanticCheck);
				}
			}
		}
		
		// (4) dump old errors
		utils.collections.forEach(oldErrors, entry => {
			entry.value.forEach(diag => printDiagnostic(diag, onError));
			newErrors[entry.key] = entry.value;
		});

		oldErrors = newErrors;
		
		if (config.verbose) {
			var headNow = process.memoryUsage().heapUsed,
				MB = 1024 * 1024;
			gutil.log(
				'[tsb]',
				'time:',
				gutil.colors.yellow((Date.now() - t1) + 'ms'),
				'mem:',
				gutil.colors.cyan(Math.ceil(headNow / MB) + 'MB'),
				gutil.colors.bgCyan('Δ' + Math.ceil((headNow - headUsed) / MB)));
			headUsed = headNow;
		}
	}

	return {
		file,
		build
	};
}

function createCompilationSettings(config: IConfiguration): ts.CompilerOptions {
	
	// language version
	if (!config['target']) {
		config['target'] = ts.ScriptTarget.ES3;
	} else if (/ES3/i.test(String(config['target']))) {
		config['target'] = ts.ScriptTarget.ES3;
	} else if (/ES5/i.test(String(config['target']))) {
		config['target'] = ts.ScriptTarget.ES5;
	} else if (/ES6/i.test(String(config['target']))) {
		config['target'] = ts.ScriptTarget.ES6;
	}
	
	// module generation
	if (/commonjs/i.test(String(config['module']))) {
		config['module'] = ts.ModuleKind.CommonJS;
	} else if (/amd/i.test(String(config['module']))) {
		config['module'] = ts.ModuleKind.AMD;
	}

	return <ts.CompilerOptions> config;
}

class ScriptSnapshot implements ts.IScriptSnapshot {

	private _text: string;
	private _lineStarts: number[];
	private _mtime: Date;

    constructor(buffer: Buffer, stat: fs.Stats) {
		this._text = buffer.toString();
		this._lineStarts = ts.computeLineStarts(this._text);
		this._mtime = stat.mtime;
    }

	public getVersion(): string {
		return this._mtime.toUTCString();
	}

    public getText(start: number, end: number): string {
        return this._text.substring(start, end);
    }

    public getLength(): number {
        return this._text.length;
    }

    public getLineStartPositions(): number[] {
		return this._lineStarts;
    }

    public getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange {
		return null;
	}
}

class LanguageServiceHost implements ts.LanguageServiceHost {

	private _settings: ts.CompilerOptions;
	private _snapshots: { [path: string]: ScriptSnapshot };
	private _defaultLib: string;
	private _dependencies: utils.graph.Graph<string>;
	private _dependenciesRecomputeList: string[];

	constructor(settings: ts.CompilerOptions) {
		this._settings = settings;
		this._snapshots = Object.create(null);
		this._defaultLib = path.normalize(path.join(__dirname, 'typescript', 'lib.d.ts'));
		this._dependencies = new utils.graph.Graph<string>(s => s);
		this._dependenciesRecomputeList = [];
	}

	log(s: string): void { 
		// nothing
	}

	getCompilationSettings(): ts.CompilerOptions {
		return this._settings;
	}

    getScriptFileNames(): string[] {
		return Object.keys(this._snapshots);
	}

    getScriptVersion(filename: string): string {
		filename = path.normalize(filename);
		return this._snapshots[filename].getVersion();
	}

    getScriptIsOpen(filename: string): boolean {
		return false;
	}

    getScriptSnapshot(filename: string): ts.IScriptSnapshot {
		filename = path.normalize(filename);
		return this._snapshots[filename];
	}

	addScriptSnapshot(filename: string, snapshot: ScriptSnapshot): ScriptSnapshot {
		filename = path.normalize(filename);
		var old = this._snapshots[filename];
		if(!old || old.getVersion() !== snapshot.getVersion()) {
			this._dependenciesRecomputeList.push(filename);
			var node = this._dependencies.lookup(filename);
			if(node) {
				node.outgoing = Object.create(null);
			}
		}
		this._snapshots[filename] = snapshot;
		return old;
	}

    getLocalizedDiagnosticMessages(): any {
		return null;
	}

    getCancellationToken(): ts.CancellationToken {
		return { isCancellationRequested: () => false };
	}

	getCurrentDirectory(): string {
		return process.cwd();
	}

    getDefaultLibFilename(): string {
		return this._defaultLib;
	}
	
	// ---- dependency management 
	
	collectDependents(filename: string, target: string[]): void {
		while (this._dependenciesRecomputeList.length) {
			this._processFile(this._dependenciesRecomputeList.pop());
		}
		filename = path.normalize(filename);
		var node = this._dependencies.lookup(filename);
		if (node) {
			utils.collections.forEach(node.incoming, entry => target.push(entry.key));
		}
	}
	
	_processFile(filename: string): void {
		if(filename.match(/.*\.d\.ts$/)) {
			return;
		}
		filename = path.normalize(filename);
		var snapshot = this.getScriptSnapshot(filename),
			info = ts.preProcessFile(snapshot.getText(0, snapshot.getLength()), true);
		
		// (1) ///-references
		info.referencedFiles.forEach(ref => {
			var resolvedPath = path.resolve(path.dirname(filename), ref.filename),
				normalizedPath = path.normalize(resolvedPath);

			this._dependencies.inertEdge(filename, normalizedPath);
		});
		
		// (2) import-require statements
		info.importedFiles.forEach(ref => {
			var stopDirname = path.normalize(this.getCurrentDirectory()),
				dirname = filename,
				found = false;

			while (!found && dirname.indexOf(stopDirname) === 0) {
				dirname = path.dirname(dirname);
				var resolvedPath = path.resolve(dirname, ref.filename),
					normalizedPath = path.normalize(resolvedPath);
					
				if(this.getScriptSnapshot(normalizedPath + '.ts')) {
					this._dependencies.inertEdge(filename, normalizedPath + '.ts');
					found = true;
					
				} else if(this.getScriptSnapshot(normalizedPath + '.d.ts')) {
					this._dependencies.inertEdge(filename, normalizedPath + '.d.ts');
					found = true;
				}
			}
		});
	}
}