// Non-exported class with methods — methods should not be marked isExported.
class PrivateSvc {
  hidden() {
    return 1;
  }
}

// Exported class with static + instance methods, a getter/setter, ctor.
export class PublicSvc {
  static make() {
    return new PublicSvc();
  }
  instanceMethod() {
    return 2;
  }
  get value() {
    return 3;
  }
  set value(_v: number) {
    // noop
  }
  constructor() {
    // noop
  }
}

// Class expression and object literal method — PR 1 gap, pinned by tests.
const _anon = class {
  hiddenInClassExpr() {
    return 4;
  }
};

const _obj = {
  objMethod() {
    return 5;
  },
};

export function outer() {
  function inner() {
    return 6;
  }
  return inner();
}

// Keep references alive so tsc doesn't whine about unused locals.
export const _refs = [_anon, _obj, PrivateSvc];
