'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const through = require("through");
const builder = require("./builder");
const ts = require("typescript");
const fs_1 = require("fs");
const path_1 = require("path");
// We actually only want to read the tsconfig.json file. So all methods
// to read the FS are 'empty' implementations.
const _parseConfigHost = {
    useCaseSensitiveFileNames: false,
    fileExists(fileName) {
        return fs_1.existsSync(fileName);
    },
    readDirectory(_rootDir, _extensions, _excludes, _includes) {
        return []; // don't want to find files!
    },
    readFile(fileName) {
        return fs_1.readFileSync(fileName, 'utf-8');
    },
};
const _defaultOnError = (err) => console.log(JSON.stringify(err, null, 4));
function create(configOrName, verbose = false, json = false, onError = _defaultOnError) {
    let options = ts.getDefaultCompilerOptions();
    let config = { json, verbose, noFilesystemLookup: false };
    if (typeof configOrName === 'string') {
        var parsed = ts.readConfigFile(configOrName, _parseConfigHost.readFile);
        options = ts.parseJsonConfigFileContent(parsed.config, _parseConfigHost, path_1.dirname(configOrName)).options;
        if (parsed.error) {
            console.error(parsed.error);
            return () => null;
        }
    }
    else {
        const base = typeof configOrName.base === 'string' ? configOrName.base : './';
        options = ts.parseJsonConfigFileContent({ compilerOptions: configOrName }, _parseConfigHost, base).options;
        Object.assign(config, configOrName);
    }
    const _builder = builder.createTypeScriptBuilder(config, options);
    function createStream(token) {
        return through(function (file) {
            // give the file to the compiler
            if (file.isStream()) {
                this.emit('error', 'no support for streams');
                return;
            }
            _builder.file(file);
        }, function () {
            // start the compilation process
            _builder.build(file => this.queue(file), onError, token).then(() => this.queue(null));
        });
    }
    let result = (token) => createStream(token);
    Object.defineProperty(result, 'program', { get: () => _builder.languageService.getProgram() });
    return result;
}
exports.create = create;
