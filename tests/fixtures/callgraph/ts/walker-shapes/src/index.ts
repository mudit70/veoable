// Fixture for the recursive walker and various call-site shapes added
// in PR 2. This deliberately exercises:
//   - arrow bound to a const (no double-emit)
//   - anonymous arrow inside an expression (must be skipped)
//   - class with constructor / getter / setter / static method
//   - non-this method call (`new Svc().compute()`) and `Svc.staticOne()`
//   - nested function inside an arrow function body
//   - class expression bound to a variable
//   - class expression NOT bound to a variable (passed as an argument)
//   - chained method calls (`a().b().c()`)
//   - multiple calls on the same line (`foo() + bar()`)
//   - await call (`await foo()`)

export function helper(): number {
  return 1;
}

export function helperA(): number {
  return helper();
}
export function helperB(): number {
  return helper();
}

// arrow bound to const — should be emitted exactly once as `arrowFn`,
// and the call inside its body must be attributed to `arrowFn`.
export const arrowFn = (): number => helper();

// nested function inside the arrow body. Both `arrowFnWithNested` and
// `nestedInArrow` should be emitted; the call to helper() inside
// `nestedInArrow` should be attributed to `nestedInArrow`.
export const arrowFnWithNested = (): number => {
  function nestedInArrow(): number {
    return helper();
  }
  return nestedInArrow();
};

// anonymous arrow inside an expression — must NOT be emitted.
export function usesAnonArrow(arr: number[]): number[] {
  return arr.map((x) => x + 1);
}

export class Svc {
  constructor() {
    helper();
  }

  get value(): number {
    return helper();
  }

  set value(_v: number) {
    helper();
  }

  compute(): number {
    return helper();
  }

  static staticOne(): number {
    return helper();
  }
}

export function callsInstanceMethod(): number {
  return new Svc().compute();
}

export function callsStaticMethod(): number {
  return Svc.staticOne();
}

// chained call: chained() returns Svc, then .compute() returns number.
export function chained(): Svc {
  return new Svc();
}
export function callsChain(): number {
  return chained().compute();
}

// multiple call expressions on the same line.
export function multipleOnLine(): number {
  return helperA() + helperB();
}

// `await foo()` — call attributed to the enclosing async function.
export async function callsAwait(): Promise<number> {
  return await Promise.resolve(helper());
}

// class expression bound to a variable — methods named via the
// variable: `BoundCls.foo`.
export const BoundCls = class {
  foo(): number {
    return helper();
  }
};

// class expression NOT bound to a variable — passed as an argument.
// Methods take the `<anonymous-class>` prefix.
function register(_cls: unknown): void {
  // no-op sink
}
register(
  class {
    bar(): number {
      return helper();
    }
  }
);
