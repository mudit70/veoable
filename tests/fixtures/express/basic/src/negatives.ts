// Shapes that look express-ish but should NOT produce APIEndpoints
// regardless of the receiver-name. These are the cases where the
// AST resolver correctly returns 'unknown' because the receiver isn't
// actually an Express routable.

import express from 'express';

const app = express();

// Computed path — not a string literal. Even though `app` is a real
// Express app, the visitor refuses to invent a route pattern.
const PATHS = { users: '/users' };
app.get(PATHS.users, (_req, res) => res.send());

// Standalone function call, no receiver chain. Not a method call at
// all, so the visitor can't even classify it.
function notAnEndpoint(_req: unknown, _res: unknown) {}
notAnEndpoint(null, null);

// Property chain that happens to end in `.get(...)` but isn't Express.
// `cache` is a plain object literal — its `get` doesn't trace back to
// any express factory.
const cache = { get: (_k: string) => null };
cache.get('key');

// Another lookalike: Map#get. The receiver is `Map`, not Express.
const myMap = new Map<string, number>();
myMap.get('key');

// A locally-defined function NAMED `express` that isn't the real
// package. Returns a plain object with a `.get` method — must NOT be
// confused for an Express app.
function express2() {
  return { get: (_p: string, _h: unknown) => {} };
}
const fake = express2();
fake.get('/fake-path', () => {});
