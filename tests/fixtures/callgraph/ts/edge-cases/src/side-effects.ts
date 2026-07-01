// A module that only has side effects when imported.
// The empty export forces it to be treated as a module, not a script.
export {};
const _sideEffect = 'side effect';
void _sideEffect;
