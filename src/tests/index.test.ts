'use strict';

import index = require('../index');
import builder = require('../builder');
import assert = require('assert');

describe('options - test that', function () { 
	
	it('does not change the config object', function () { 
		
		var config: builder.IConfiguration = {
			json: true,
			verbose: true
		};
		
		Object.freeze(config);
		index.create(config);
		
		assert.equal(Object.keys(config).length, 2);
		
	});
});