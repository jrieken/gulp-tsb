class User {
	
	constructor(private _name:string, private _foo=true) {
		
	}
	
	get first():string {
		return this._name.split(/\s/)[0];
	}
	
	get last():string {
		return this._name.split(/\s/)[1];
	}
}

new User('Joh', true).first;