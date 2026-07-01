// #8b — wrapper defined in a separate module. Verifies that the
// free-function resolver follows imports via the lang-ts shared
// type-checker-first resolver (handles default exports, re-exports,
// path-mapped specifiers).
export function libApiGet(url: string) {
  return fetch(url);
}

export const libApiPost = (url: string) => fetch(url, { method: 'POST' });
