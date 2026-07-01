// Direct same-file call: caller -> helper
export function caller() {
  return helper();
}

function helper() {
  return 1;
}

// Method call inside a method
export class Service {
  run() {
    return this.compute();
  }

  compute() {
    return 42;
  }
}

// Indirect callback
export function withCallback(cb: () => number) {
  return cb();
}

// Conditional call inside an if
export function conditional(flag: boolean) {
  if (flag) {
    return helper();
  }
  return 0;
}

// Call inside a nested function — exercises nested-function walking
export function outer() {
  function inner() {
    return helper();
  }
  return inner();
}
