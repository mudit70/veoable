// Every shape the fetch visitor should detect.

// Plain GET with a string literal URL.
export async function listUsers() {
  return fetch('/api/users');
}

// Explicit method via options object.
export async function createUser(email: string) {
  return fetch('/api/users', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

// Template literal URL with a static prefix.
export async function getUserById(id: number) {
  return fetch(`/api/users/${id}`);
}

// Template literal URL + explicit method via options.
export async function deleteUser(id: number) {
  return fetch(`/api/users/${id}`, { method: 'DELETE' });
}

// Await + fetch.
export async function awaited() {
  const response = await fetch('/api/health');
  return response;
}

// Shorthand-property method via a string literal key.
export async function headRequest() {
  return fetch('/api/users', { 'method': 'HEAD' });
}

// NoSubstitutionTemplateLiteral URL — backticks, no interpolation.
// Should be treated identically to a StringLiteral (exact confidence).
export async function noSubstTemplate() {
  return fetch(`/api/status`);
}

// Template expression with interpolation in the MIDDLE, not at the end.
// Head is `/api/users/`, which is still a valid static prefix.
export async function middleInterp(id: number) {
  return fetch(`/api/users/${id}/posts`);
}

// Lowercase literal method value — must be uppercased.
export async function lowercaseMethod() {
  return fetch('/api/users', { method: 'post' });
}

// Spread BEFORE the explicit method. The spread is skipped by the
// property loop; the explicit `method` is still found.
export async function spreadBeforeMethod(extra: RequestInit) {
  return fetch('/api/users', { ...extra, method: 'PUT' });
}

// Spread AFTER the explicit method. The loop finds the explicit
// method first and we do not pretend to reason about spread shadowing.
export async function spreadAfterMethod(extra: RequestInit) {
  return fetch('/api/users', { method: 'PATCH', ...extra });
}

// Wrong-case key `METHOD`. The fetch spec does not accept uppercase
// keys; the visitor ignores it and the call defaults to GET.
export async function wrongCaseKey() {
  // @ts-expect-error — excess property; the visitor should still see it as an object literal.
  return fetch('/api/users', { METHOD: 'POST' });
}

// Computed property-name key `{ [methodKey]: 'POST' }`. The name node
// is neither Identifier nor StringLiteral, so it is skipped; the
// method defaults to GET.
export async function computedKey(methodKey: string) {
  // @ts-expect-error — computed key isn't assignable to RequestInit.
  return fetch('/api/users', { [methodKey]: 'POST' });
}

// URL exact + method dynamic → dynamic overall.
export async function urlExactMethodDynamic(method: string) {
  return fetch('/api/users', { method });
}

// URL pattern + method dynamic → dynamic overall.
export async function urlPatternMethodDynamic(id: number, method: string) {
  return fetch(`/api/users/${id}`, { method });
}

// Nested arrow inside an outer function. The fetch must attribute to
// the INNERMOST enclosing function (the arrow), not the outer one.
export function outerWithNestedArrow() {
  const inner = () => fetch('/api/inner');
  return inner;
}

// #9 — Shadowed `fetch` local with arrow-function initializer.
// Was a known false positive; now NOT detected.
export function shadowedFetch() {
  const fetch = (_url: string) => null;
  return fetch('/api/shadowed');
}

// #9 — Shadowed `fetch` via function declaration. Same logic.
export function shadowedFunctionDecl() {
  function fetch(_url: string) {
    return null;
  }
  return fetch('/api/shadowed-fn');
}

// #9 — Shadowed wrapper name (`fetchApi`). Verifies the guard
// applies to all members of FETCH_WRAPPER_NAMES, not just `fetch`.
export function shadowedWrapperName() {
  const fetchApi = (_url: string) => null;
  return fetchApi('/api/shadowed-wrapper');
}

// #9 — Aliased global. The initializer is an Identifier
// (`fetchFromUndici`) whose type is `typeof globalThis.fetch`, so
// the guard's function-shape check returns false → still detected.
declare const fetchFromUndici: typeof globalThis.fetch;
export async function undiciStyle() {
  const fetch = fetchFromUndici;
  return fetch('/api/undici');
}

