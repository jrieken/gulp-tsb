var User = (function () {
    function User(_name, _foo) {
        if (_foo === void 0) { _foo = true; }
        this._name = _name;
        this._foo = _foo;
    }
    Object.defineProperty(User.prototype, "first", {
        get: function () {
            return this._name.split(/\s/)[0];
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(User.prototype, "last", {
        get: function () {
            return this._name.split(/\s/)[1];
        },
        enumerable: true,
        configurable: true
    });
    return User;
})();
new User('Joh', true).first;
