// Minimal stubs for state management libraries.

// Redux Toolkit
export function createAsyncThunk<T>(type: string, fn: () => Promise<T>) {
  return { type, fn };
}

export function createSlice(_config: Record<string, unknown>) {
  return {};
}

// Zustand
export function create<T>(fn: (set: (s: Partial<T>) => void, get: () => T) => T): () => T {
  return () => fn(() => {}, () => ({} as T));
}

// MobX
export function autorun(fn: () => void) { fn(); }
export function reaction<T>(expr: () => T, effect: (val: T) => void) { effect(expr()); }
export function when(predicate: () => boolean, effect?: () => void) { if (predicate() && effect) effect(); }
export function makeAutoObservable<T>(_target: T): T { return _target; }

// Pinia
export function defineStore<T>(id: string, options: T): T {
  return options;
}

// Generic
export function dispatch(_action: unknown) {}

// TanStack Query / RTK Query
export function useQuery<T>(_opts: any, _arg2?: any): { data: T | undefined } { return { data: undefined }; }
export function useMutation<T>(_opts: any): { mutate: (v: T) => void } { return { mutate: () => {} }; }
export function useInfiniteQuery<T>(_opts: any): { data: T | undefined } { return { data: undefined }; }
export function useSuspenseQuery<T>(_opts: any): { data: T } { return { data: {} as T }; }

// Redux Saga effects
export function takeLatest(_t: string, _h: any) {}
export function takeEvery(_t: string, _h: any) {}
export function takeLeading(_t: string, _h: any) {}
export function throttle(_d: number, _t: string, _h: any) {}
export function debounce(_d: number, _t: string, _h: any) {}
export function call(_fn: any, ..._args: any[]) {}
export function put(_action: any) {}
