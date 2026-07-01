// Computed property access — always dynamic
export function computedAccess(obj: Record<string, () => number>, key: string) {
  return obj[key]();
}

// Callback parameter — indirect
export function callbackArg(cb: () => number) {
  return cb();
}

// Variable holding a runtime value — indirect (variable, not function decl).
// Declared without an initializer so the walker does NOT bind it to a
// function shape; subsequent assignments mean its callee target cannot
// be resolved statically.
export function runtimeValue(getF: () => () => number) {
  let f: () => number;
  f = getF();
  return f();
}

// IIFE — non-trivial callee expression, dynamic
export function iife() {
  return (function () {
    return 1;
  })();
}
