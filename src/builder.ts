/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/vinyl/vinyl.d.ts" />
/// <reference path="../typings/gulp-util/gulp-util.d.ts" />

'use strict';

import fs = require('fs');
import vinyl = require('vinyl');
import path = require('path');
import utils = require('./utils');
import gutil = require('gulp-util');
import ts = require('./typescript/typescriptServices');

export interface IConfiguration {
	json: boolean;
	verbose: boolean;
	[option: string]: string | number | boolean;
}

export interface IFileDelta {
	added?:vinyl[];
	changed?:vinyl[];
	deleted?:vinyl[];
}

export interface ITypeScriptBuilder {
	build(out: (file:vinyl)=>void, onError:(err:any)=>void): void;
	file(file: vinyl): void;
}

export function createTypeScriptBuilder(config:IConfiguration): ITypeScriptBuilder {
	
	var host = new LanguageServiceHost(createCompilationSettings(config)),
		languageService = ts.createLanguageService(host, ts.createDocumentRegistry()),
		oldErrors: { [path:string]: ts.Diagnostic[] } = Object.create(null),
		headUsed = process.memoryUsage().heapUsed;
	
	function createCompilationSettings(config:IConfiguration): ts.CompilerOptions {
    	
		// language version
		if(!config['target']) {
			config['target'] = ts.ScriptTarget.ES3;
		} else if(/ES3/i.test(String(config['target']))) {
			config['target'] = ts.ScriptTarget.ES3;
		} else if(/ES5/i.test(String(config['target']))) {
			config['target'] = ts.ScriptTarget.ES5;
		} else if(/ES6/i.test(String(config['target']))) {
			config['target'] = ts.ScriptTarget.ES6;
		}
		
		// module generation
		if (/commonjs/i.test(String(config['module']))) {
			config['module'] = ts.ModuleKind.CommonJS;
		} else if (/amd/i.test(String(config['module']))) {
			config['module'] = ts.ModuleKind.AMD;
		}
		
		var result = <ts.CompilerOptions> config;
//		if(config.verbose) {
//			gutil.log(JSON.stringify(result));
//		}
		return result;
	}
	
	function printDiagnostic(diag:ts.Diagnostic, onError:(err:any)=>void):void {
	
		var lineAndCh = diag.file.getLineAndCharacterFromPosition(diag.start),
			message:string;
			
		if(!config.json) {
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
	
	if(!host.getCompilationSettings().noLib) {
		var defaultLib = host.getDefaultLibFilename();
		host.addScriptSnapshot(defaultLib, new ScriptSnapshot(fs.readFileSync(defaultLib), fs.statSync(defaultLib)));
	}
	
	return {
		build: (out: (file:vinyl)=>void, onError: (err: any) => void) => { 

			var task = host.createSnapshotAndAdviseValidation(),
				newErrors: { [path: string]: ts.Diagnostic[] } = Object.create(null),
				t1 = Date.now();
			
			// (1) check for syntax errors
			task.changed.forEach(fileName => { 
				
				if(config.verbose) {
					gutil.log(gutil.colors.cyan('[check syntax]'), fileName);
				}
				
				delete oldErrors[fileName];
				
				languageService.getSyntacticDiagnostics(fileName).forEach(diag => {
					printDiagnostic(diag, onError);
					utils.collections.lookupOrInsert(newErrors, fileName, []).push(diag);
				});
			});
			
			// (2) emit
			task.changed.forEach(fileName => { 
				
				if(config.verbose) {
					gutil.log(gutil.colors.cyan('[emit code]'), fileName);
				}
				
				var output = languageService.getEmitOutput(fileName);
				output.outputFiles.forEach(file => { 
					out(new vinyl({
						path: file.name,
						contents: new Buffer(file.text)
					}));
				});
			});

			// (3) semantic check
			task.changedOrDependencyChanged.forEach(fileName => { 
					
				if(config.verbose) {
					gutil.log(gutil.colors.cyan('[check semantics]'), fileName);
				}
				
				delete oldErrors[fileName];
				
				languageService.getSemanticDiagnostics(fileName).forEach(diag => { 
					printDiagnostic(diag, onError);
					utils.collections.lookupOrInsert(newErrors, fileName, []).push(diag);
				});
			});

			// (4) dump old errors
			utils.collections.forEach(oldErrors, entry => { 
				entry.value.forEach(diag => printDiagnostic(diag, onError));
				newErrors[entry.key] = entry.value;
			});

			oldErrors = newErrors;
			
			if(config.verbose) {
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
		},
		
		file: (file) => { 
			var snapshot = new ScriptSnapshot(file.contents, file.stat);
			host.addScriptSnapshot(file.path, snapshot);
		}
	};
}

class ScriptSnapshot implements ts.IScriptSnapshot {

	private _text: string;
	private _lineStarts: number[];
	private _mtime: Date;
	
    constructor(buffer:Buffer, stat:fs.Stats) {
		this._text = buffer.toString();
		this._lineStarts = ts.computeLineStarts(this._text);
		this._mtime = stat.mtime;
    }
	
	public getVersion():string {
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
	
    public getChangeRange(oldSnapshot:ts.IScriptSnapshot):ts.TextChangeRange {
		return null;
	}
}

interface IValidationTask {
	changed: string[];
	changedOrDependencyChanged: string[];
}

class ProjectSnapshot {

	private _dependencies: utils.graph.Graph<string>;
	private _versions: { [path: string]: string; };
	
	constructor(host:ts.LanguageServiceHost) {
		this._captureState(host);
	}
	
	private _captureState(host:ts.LanguageServiceHost):void {
		
		this._dependencies = new utils.graph.Graph<string>(s => s);
		this._versions = Object.create(null);
		
		host.getScriptFileNames().forEach(fileName => { 
			
			fileName = path.normalize(fileName);

			// (1) paths and versions
			this._versions[fileName] = host.getScriptVersion(fileName);
			
			
			// (2) dependency graph for *.ts files
			if(!fileName.match(/.*\.d\.ts$/)) { 
				
				var snapshot = host.getScriptSnapshot(fileName),
					info = ts.preProcessFile(snapshot.getText(0, snapshot.getLength()), true);

				info.referencedFiles.forEach(ref => { 
					
					var resolvedPath = path.resolve(path.dirname(fileName), ref.filename),
						normalizedPath = path.normalize(resolvedPath);
					
					this._dependencies.inertEdge(fileName, normalizedPath);
//					console.log(fileName + ' -> ' + normalizedPath);
				});
				
				info.importedFiles.forEach(ref => { 
					
					var stopDirname = path.normalize(host.getCurrentDirectory()),
						dirname = fileName;
					
					while(dirname.indexOf(stopDirname) === 0) {

						dirname = path.dirname(dirname);
						
						var resolvedPath = path.resolve(dirname, ref.filename),
							normalizedPath = path.normalize(resolvedPath);

						// try .ts
						if (['.ts', '.d.ts'].some(suffix => {
							var candidate = normalizedPath + suffix;
							if (host.getScriptSnapshot(candidate)) {
								this._dependencies.inertEdge(fileName, candidate);
								//							console.log(fileName + ' -> ' + candidate);
								return true;
							}
							return false;
						})) {
							// found, ugly code!
							break;
						};
					}
				});
			}
		});
	}
	
	public whatToValidate(host: ts.LanguageServiceHost):IValidationTask {

		var changed: string[] = [],
			added: string[] = [],
			removed: string[] = [];
			
		// compile file delta (changed, added, removed)
		var idx: { [path: string]: string } = Object.create(null);
		host.getScriptFileNames().forEach(fileName => idx[fileName] = host.getScriptVersion(fileName));
		utils.collections.forEach(this._versions, entry => { 
			var versionNow = idx[entry.key];
			if(typeof versionNow === 'undefined') {
				// removed
				removed.push(entry.key);
			} else if(typeof versionNow === 'string' && versionNow !== entry.value) {
				// changed
				changed.push(entry.key);
			}
			delete idx[entry.key];
		});
		// cos we removed all we saw earlier
		added = Object.keys(idx);

		// what to validate?
		var syntax = changed.concat(added),
			semantic: string[] = [];
		
		if(removed.length > 0 || added.length > 0) {
			semantic = host.getScriptFileNames();
		} else {
			// validate every change file *plus* the files
			// that depend on the changed file 
			changed.forEach(fileName => this._dependencies.traverse(fileName, false, data => semantic.push(data)));
		}
		
		return {
			changed: syntax,
			changedOrDependencyChanged: semantic
		};
	}
}

class LanguageServiceHost implements ts.LanguageServiceHost {

	private _settings: ts.CompilerOptions;
	private _snapshots: { [path: string]: ScriptSnapshot };
	private _defaultLib: string;
	private _projectSnapshot: ProjectSnapshot;
	
	constructor(settings:ts.CompilerOptions) {
		this._settings = settings;
		this._snapshots = Object.create(null);
		this._defaultLib = path.normalize(path.join(__dirname, 'typescript', 'lib.d.ts'));
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
	
    getScriptVersion(fileName: string): string {
		fileName = path.normalize(fileName);
		return this._snapshots[fileName].getVersion();
	}
	
    getScriptIsOpen(fileName: string): boolean {
		return false;
	}
	
    getScriptSnapshot(fileName: string): ts.IScriptSnapshot {
		fileName = path.normalize(fileName);
		return this._snapshots[fileName];
	}
	
	addScriptSnapshot(fileName:string, snapshot:ScriptSnapshot):ScriptSnapshot {
		fileName = path.normalize(fileName);
		var old = this._snapshots[fileName];
		this._snapshots[fileName] = snapshot;
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
	
	createSnapshotAndAdviseValidation():IValidationTask {
		var ret: IValidationTask;
		if(!this._projectSnapshot) {
			ret = {
				changed: this.getScriptFileNames(),
				changedOrDependencyChanged: this.getScriptFileNames()
			};
		} else {
			ret = this._projectSnapshot.whatToValidate(this);
		}
		this._projectSnapshot = new ProjectSnapshot(this);
		return ret;
	}
}
