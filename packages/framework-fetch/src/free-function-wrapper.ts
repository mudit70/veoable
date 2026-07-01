import {
  Node,
  type CallExpression,
  type FunctionDeclaration,
  type ArrowFunction,
  type FunctionExpression,
} from 'ts-morph';
import { resolveIdentifierTypeToDeclaration } from '@adorable/lang-ts';

/**
 * #8b — free-function fetch wrapper resolver.
 *
 * Detects call sites that go through a free-function wrapper around
 * `fetch` and resolves them back to a concrete URL + HTTP method.
 *
 * Worked example:
 *
 *   function apiGet(url: string) {
 *     return fetch(url);
 *   }
 *
 *   apiGet('/api/users');     // ← we want this call site to surface as
 *                             //   a caller for GET /api/users
 *
 * The wrapper-class resolver (`./wrapper-resolver.ts`) already handles
 * the `client.<method>(...)` shape; this module fills the analogous
 * gap for plain function call sites where the receiver is just the
 * function identifier.
 *
 * Resolution is intentionally conservative — only the canonical shape
 * `function f(p) { return fetch(p[, opts]) }` (and its arrow variant)
 * is recognized. URL composition (`fetch('/api/v1' + p)`),
 * template-segment forwarding, and multi-parameter substitution are
 * deferred to a future enrichment pass.
 */

export interface FreeFunctionWrapperResolution {
  urlLiteral: string;
  httpMethod: string;
}

/**
 * Try to resolve a CallExpression of the form `<identifier>(<args>)` as
 * a fetch-wrapper invocation. Returns null when:
 *   - the callee is not a bare identifier,
 *   - the identifier doesn't resolve to a function whose body forwards
 *     a single parameter to a `fetch(...)` call,
 *   - the call-site argument at that parameter's index is not a
 *     string literal.
 *
 * The caller is responsible for checking that the identifier is NOT
 * already in `FETCH_WRAPPER_NAMES` (those are handled by the regular
 * `isFetchCall` path).
 */
export function resolveFreeFunctionWrapperCall(
  call: CallExpression,
): FreeFunctionWrapperResolution | null {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return null;

  const fn = resolveCalleeToFunction(callee);
  if (!fn) return null;

  const paramName = singleForwardedParameterName(fn);
  if (!paramName) return null;

  const paramIndex = fn.getParameters().findIndex((p) => p.getName() === paramName);
  if (paramIndex < 0) return null;

  const callArgs = call.getArguments();
  if (callArgs.length <= paramIndex) return null;
  const arg = callArgs[paramIndex];

  let urlLiteral: string | null = null;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    urlLiteral = arg.getLiteralValue();
  }
  if (urlLiteral === null) return null;

  const httpMethod = inferMethodFromInnerFetch(fn) ?? 'GET';

  return { urlLiteral, httpMethod };
}

function resolveCalleeToFunction(
  ident: Node,
): FunctionDeclaration | ArrowFunction | FunctionExpression | null {
  if (!Node.isIdentifier(ident)) return null;
  // Use lang-ts's shared cross-file resolver (CLAUDE.md: cross-cutting
  // resolution belongs in lang-ts, not duplicated per-framework).
  // Type-checker-first follows aliased imports, re-exports, and path-
  // mapped specifiers transparently.
  const decl = resolveIdentifierTypeToDeclaration(ident, (d) => {
    const file = d.getSourceFile();
    if (file.getFilePath().endsWith('.d.ts')) return false;
    if (file.getFilePath().includes('/node_modules/')) return false;
    if (Node.isFunctionDeclaration(d) && d.hasBody()) return true;
    if (Node.isVariableDeclaration(d)) {
      const init = d.getInitializer();
      return Boolean(init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)));
    }
    return false;
  });
  if (!decl) return null;

  if (Node.isFunctionDeclaration(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init;
    }
  }
  return null;
}

/**
 * Inspect a function body for a single `return fetch(<paramRef>, ...)`
 * (or `fetch(<paramRef>, ...)` as the only relevant statement) where
 * `<paramRef>` is one of the function's parameters by name. Returns
 * the parameter's name if matched; null otherwise.
 *
 * Walks descendants — accepts `return fetch(p)`, bare-statement
 * `fetch(p)`, and `await fetch(p)`. Conservative: returns null if
 * there are multiple top-level fetch calls, since we cannot decide
 * which one the call site should be attributed to.
 */
function singleForwardedParameterName(
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
): string | null {
  const paramNames = new Set(fn.getParameters().map((p) => p.getName()));
  if (paramNames.size === 0) return null;

  const innerFetches: CallExpression[] = [];
  fn.forEachDescendant((d) => {
    if (!Node.isCallExpression(d)) return;
    const c = d.getExpression();
    if (Node.isIdentifier(c) && c.getText() === 'fetch') {
      innerFetches.push(d);
    }
  });
  if (innerFetches.length !== 1) return null;

  const fetchArgs = innerFetches[0].getArguments();
  if (fetchArgs.length === 0) return null;
  const urlArg = fetchArgs[0];
  if (!Node.isIdentifier(urlArg)) return null;
  const name = urlArg.getText();
  if (!paramNames.has(name)) return null;
  return name;
}

/**
 * Read the inner fetch's options-object `method:` literal. Returns
 * null when the wrapper doesn't pass an options object or the options
 * object's `method` field isn't a string literal.
 */
function inferMethodFromInnerFetch(
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
): string | null {
  let method: string | null = null;
  fn.forEachDescendant((d, traversal) => {
    if (!Node.isCallExpression(d)) return;
    const c = d.getExpression();
    if (!Node.isIdentifier(c) || c.getText() !== 'fetch') return;
    const args = d.getArguments();
    if (args.length < 2) {
      traversal.stop();
      return;
    }
    const opts = args[1];
    if (!Node.isObjectLiteralExpression(opts)) {
      traversal.stop();
      return;
    }
    for (const prop of opts.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const nameNode = prop.getNameNode();
      const propName =
        Node.isIdentifier(nameNode) ? nameNode.getText() :
        Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : null;
      if (propName !== 'method') continue;
      const init = prop.getInitializer();
      if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
        method = init.getLiteralValue().toUpperCase();
      }
      break;
    }
    traversal.stop();
  });
  return method;
}

