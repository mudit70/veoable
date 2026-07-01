// Minimal React stub — the visitor dispatches on identifier text,
// not types, so this is enough to make the fixture compile.

export function useEffect(_fn: () => void | (() => void), _deps?: unknown[]): void {}
export function useLayoutEffect(_fn: () => void | (() => void), _deps?: unknown[]): void {}
export function useState<T>(initial: T): [T, (v: T) => void] {
  return [initial, () => {}];
}
export function useCallback<T extends (...args: unknown[]) => unknown>(fn: T, _deps: unknown[]): T {
  return fn;
}

export namespace JSX {
  export interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }
}
