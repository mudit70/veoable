// #9 — Real `import { fetch } from './undici-stub'`. Symbol resolves
// to an ImportSpecifier, not a function-shape declaration, so the
// guard's loop `continue`s past it and the call is still detected
// as a fetch caller.
import { fetch } from './undici-stub.js';

export async function importedFetch() {
  return fetch('/api/imported');
}
