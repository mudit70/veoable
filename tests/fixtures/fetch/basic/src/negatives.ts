// Shapes that look fetch-ish but should NOT produce ClientSideAPICaller nodes.

// Method call, not a bare identifier.
const cache = {
  fetch: (_key: string) => null,
};
export function cacheHit() {
  return cache.fetch('key');
}

// `this.fetch(...)` — class method.
class Thing {
  fetch(_url: string) {
    return null;
  }
  doStuff() {
    return this.fetch('/api/stuff');
  }
}
export { Thing };

// Constructor — `new Fetch(...)` is a NewExpression, not CallExpression
class Fetch {
  constructor(public url: string) {}
}
export function ctor() {
  return new Fetch('/api/users');
}

// Top-level fetch — no enclosing function, should be silently skipped.
void fetch('/top-level');

// `window.fetch(...)` — PropertyAccessExpression, not a bare
// identifier. Pinned as a known non-detection (type-based detection
// is deferred to a future PR).
export function viaWindow() {
  return window.fetch('/api/window');
}

// `globalThis.fetch(...)` — same; PropertyAccessExpression. Pinned
// as a known non-detection.
export function viaGlobalThis() {
  return globalThis.fetch('/api/global');
}
