// #8b — free-function wrapper around fetch. The wrapper itself
// emits a `dynamic` ClientSideAPICaller for the inner `fetch(url)`
// (URL is the parameter), AND each call site of the wrapper emits a
// resolved-URL caller substituting the call-site argument.

function apiGet(url: string) {
  return fetch(url);
}

function apiPost(url: string) {
  return fetch(url, { method: 'POST' });
}

const apiDelete = (url: string) => fetch(url, { method: 'DELETE' });

// Wrapper with multiple parameters — only the URL parameter is
// substituted; the others are ignored for URL resolution.
function apiGetWithBody(url: string, _body: unknown) {
  return fetch(url, { method: 'POST' });
}

// Call sites — each should be detected as a ClientSideAPICaller
// with the wrapper's resolved URL + method.
export function listUsersViaWrapper() {
  return apiGet('/api/users');
}

export function createUserViaWrapper() {
  return apiPost('/api/users');
}

export function deleteUserViaWrapper() {
  return apiDelete('/api/users/42');
}

export function callWithBody() {
  return apiGetWithBody('/api/items', { name: 'x' });
}

// Negative — the wrapper's body has multiple fetch calls, so it's
// ambiguous; we should NOT emit a resolved caller for the call site.
function apiAmbiguous(url: string) {
  fetch('/api/log');
  return fetch(url);
}

export function ambiguousCallSite() {
  return apiAmbiguous('/api/x');
}

// Negative — the call-site argument is not a string literal, so the
// resolution falls back to whatever the wrapper itself emits (no
// resolved-URL caller for the call site).
export function nonLiteralCallSite(path: string) {
  return apiGet(path);
}

// #8b — cross-file imported wrapper. Resolves via lang-ts's
// type-checker-first resolver.
import { libApiGet, libApiPost } from './free-function-wrapper-lib.js';

export function listViaImportedWrapper() {
  return libApiGet('/api/imported-list');
}

export function postViaImportedWrapper() {
  return libApiPost('/api/imported-post');
}
