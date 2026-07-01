// Dynamic / pattern cases.

// Computed URL — identifier.
export async function computedUrl(url: string) {
  return fetch(url);
}

// Computed URL — call expression.
export async function viaHelper() {
  return fetch(buildUrl('/users'));
}

// Non-literal options object (identifier).
export async function dynamicOptions(opts: RequestInit) {
  return fetch('/api/users', opts);
}

// Literal options but non-literal method value.
export async function dynamicMethod(method: string) {
  return fetch('/api/users', { method });
}

// Template with NO static prefix (dollar-brace at position 0).
export async function emptyPrefixTemplate(base: string) {
  return fetch(`${base}/api/users`);
}

// Concatenated string URL — BinaryExpression, falls through to dynamic.
export async function concatString(path: string) {
  return fetch('/api/' + path);
}

// `new URL(...)` argument — NewExpression, falls through to dynamic.
export async function urlObject(base: string) {
  return fetch(new URL('/api/users', base));
}

// `new Request(...)` argument — NewExpression, falls through to dynamic.
export async function requestObject() {
  return fetch(new Request('/api/users'));
}

// Method chain — `.toString()` returns a CallExpression, dynamic.
export async function toStringChain(someUrl: URL) {
  return fetch(someUrl.toString());
}

// `{ method: undefined }` — initializer is an Identifier, not a
// literal, so the method is treated as dynamic.
export async function methodUndefined() {
  return fetch('/api/users', { method: undefined });
}

// #2 — `opts` resolves to a same-file object literal const. The
// type-checker traces `opts` to `{ method: 'POST' }` and recovers
// the method exactly instead of falling back to dynamic.
const POST_OPTS = { method: 'POST' };
export async function viaLocalOptsConst() {
  return fetch('/api/users', POST_OPTS);
}

// #2 — `let opts: RequestInit = { method: 'PUT' }` — same logic.
const putOpts: RequestInit = { method: 'PUT' };
export async function viaTypedOptsConst() {
  return fetch('/api/users', putOpts);
}

// #2 — chain through one level of identifier indirection.
const ALIAS_OPTS = POST_OPTS;
export async function viaAliasOptsConst() {
  return fetch('/api/users', ALIAS_OPTS);
}

// #2 — opts that we cannot resolve (function-parameter shape) still
// degrades to dynamic.
export async function viaParamOpts(opts: RequestInit) {
  return fetch('/api/users', opts);
}

// #2 — `let` declaration is intentionally NOT followed (could be
// reassigned after declaration; recovering the initial method
// would be wrong-and-confident).
let mutableOpts = { method: 'GET' };
mutableOpts = { method: 'POST' };
export async function viaLetOpts() {
  return fetch('/api/users', mutableOpts);
}

// #2 — cross-file imported const resolves via lang-ts's
// resolveIdentifierTypeToDeclaration (type-checker-first, falls back
// to syntactic import walk).
import { REMOTE_DELETE_OPTS } from './options-module.js';
export async function viaImportedOpts() {
  return fetch('/api/users', REMOTE_DELETE_OPTS);
}

function buildUrl(path: string): string {
  return '/api' + path;
}

// #188 — `${API_BASE}/...` template where the head is empty but the
// FIRST interpolation resolves to a literal. resolveUrlPattern collapses
// it to a single static prefix, so urlLiteral is `https://example.com/api/users/:p0`.
const API_BASE = 'https://example.com';

export async function templateWithResolvedConstantHead(id: number) {
  return fetch(`${API_BASE}/api/users/${id}`);
}

// #188 — multi-piece `+` concat with a resolved constant prefix and a
// dynamic middle. Was dynamic on the bespoke fetch path; now resolves
// via resolveUrlPattern.
const CONST_PREFIX = '/api/v1/';

export async function concatWithConstantPrefix(name: string) {
  return fetch(CONST_PREFIX + 'songs/' + name + '/play');
}

// #188 — fully-resolved string built from constants + literals. Both
// sides resolve, so confidence is 'exact', no placeholders.
const FULL_PATH = '/api/' + 'health';

export async function fullyResolvedConcat() {
  return fetch(FULL_PATH);
}
