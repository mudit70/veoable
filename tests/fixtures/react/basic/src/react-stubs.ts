// Minimal stubs so ts-morph can resolve the fixtures without pulling
// in the real react package. The visitor does not use type
// information — it dispatches on JSX attribute names and hook call
// identifiers — so these stubs just have to satisfy the compiler.

export function useEffect(_fn: () => void | (() => void), _deps?: unknown[]): void {}
export function useLayoutEffect(_fn: () => void | (() => void), _deps?: unknown[]): void {}
export function useInsertionEffect(_fn: () => void | (() => void), _deps?: unknown[]): void {}
export function useState<T>(initial: T): [T, (v: T) => void] {
  return [initial, () => {}];
}
export function useMemo<T>(factory: () => T, _deps: unknown[]): T {
  return factory();
}
export function useCallback<T extends (...args: unknown[]) => unknown>(fn: T, _deps: unknown[]): T {
  return fn;
}

// Pretend JSX factory so .tsx files type-check. We do NOT care about
// proper JSX typing — the tsconfig sets `jsx: "react-jsx"` and the
// visitor walks the raw AST, not resolved types.
export namespace JSX {
  export interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }
}
