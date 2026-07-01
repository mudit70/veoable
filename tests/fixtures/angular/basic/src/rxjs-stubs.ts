// Minimal stubs for RxJS and NgRx types.

export class Observable<T> {
  subscribe(_observer?: Partial<{ next: (v: T) => void; error: (e: unknown) => void; complete: () => void }>): { unsubscribe: () => void } {
    return { unsubscribe: () => {} };
  }
  pipe(..._operators: unknown[]): Observable<T> {
    return this;
  }
}

export class Subject<T> extends Observable<T> {
  next(_value: T): void {}
}

export class BehaviorSubject<T> extends Subject<T> {
  constructor(public value: T) { super(); }
}

export function of<T>(..._values: T[]): Observable<T> {
  return new Observable();
}

export function switchMap<T, R>(_project: (value: T) => Observable<R>) {
  return {};
}

export function debounceTime(_duration: number) {
  return {};
}

export function map<T, R>(_project: (value: T) => R) {
  return {};
}

export function catchError<T>(_selector: (err: unknown) => Observable<T>) {
  return {};
}

// NgRx stubs
export class Actions extends Observable<{ type: string }> {}

export function createEffect(_source: () => Observable<unknown>): unknown {
  return {};
}

export function ofType(..._types: string[]) {
  return {};
}
