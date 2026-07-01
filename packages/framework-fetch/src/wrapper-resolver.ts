import {
  Node,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type ConstructorDeclaration,
  type Expression,
  type MethodDeclaration,
  type ParameterDeclaration,
  type TemplateExpression,
} from 'ts-morph';

/**
 * Detect call sites that go through a "fetch wrapper" — typically a
 * class whose method internally calls `fetch(...)` — and resolve them
 * back to a concrete URL + HTTP method (#182, half A).
 *
 * Worked example (from the test-code-comprehension repo):
 *
 *   class PostAPIClient {
 *     constructor(private url: string) {}
 *     async post(requestName: string, body: any) {
 *       return fetch(`${this.url}?r=${requestName}`, {
 *         method: 'POST',
 *         body: JSON.stringify(body),
 *       });
 *     }
 *   }
 *
 *   const client = new PostAPIClient('/api/jade');
 *   client.post('GenerateBundle', body);   // ← we want this call site
 *                                           //   to surface as a caller
 *                                           //   for POST /api/jade?r=GenerateBundle
 *
 * The framework-fetch visitor already detects the inner fetch call as
 * a single dynamic caller in the wrapper file; that's not what's
 * asked. The user wants every USE SITE attributed back to the screen
 * / function that triggered it, with the URL specialized using the
 * arguments provided at that site. This module does that by tracing:
 *
 *   1. The receiver expression to its declaration. Most commonly:
 *      `const client = new ClassName(arg)` — we capture the
 *      constructor args.
 *   2. The class to its method definition.
 *   3. The method body for a single fetch call whose URL template
 *      references this.<x> and method parameters.
 *   4. Substitution: `this.<x>` ← receiver-side constructor arg by
 *      parameter property or constructor assignment;
 *      `<methodParam>` ← call-site arg by index.
 *
 * Detection is intentionally conservative — when any link in the
 * chain is non-static (constructor arg is a variable, fetch URL has
 * shapes we don't model, etc.) we return `null` and the call site
 * is left to whatever other visitors emit. Conservative wins prevent
 * fabricating endpoints that don't exist.
 */

/**
 * Method names that are unambiguously NOT routing wrappers and have
 * heavy presence in any TS codebase. We short-circuit before doing
 * expensive symbol resolution. Methods on Map / Set / Array / etc.
 * dominate this list.
 */
const NEVER_WRAPPER_METHOD_NAMES: ReadonlySet<string> = new Set([
  // Array / iteration
  'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'sort', 'reverse',
  'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'find', 'findIndex',
  'every', 'some', 'includes', 'indexOf', 'lastIndexOf', 'concat', 'join',
  'flat', 'flatMap', 'fill', 'copyWithin', 'entries', 'keys', 'values',
  // Map / Set
  'has', 'clear', 'add',
  // String
  'charAt', 'charCodeAt', 'codePointAt', 'startsWith', 'endsWith',
  'replace', 'replaceAll', 'split', 'trim', 'trimStart', 'trimEnd',
  'toLowerCase', 'toUpperCase', 'normalize', 'padStart', 'padEnd', 'repeat',
  'substring', 'substr', 'matchAll',
  // Promise
  'then', 'catch', 'finally',
  // Object
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  // Common DOM / lifecycle (won't have fetch in body)
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'querySelector',
  'querySelectorAll', 'getElementById', 'appendChild', 'removeChild',
  // Common test framework calls
  'expect', 'describe', 'it', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
]);

export interface WrapperResolution {
  /** Resolved URL (literal or template prefix). */
  urlLiteral: string | null;
  /** True when the resolution produced a fully literal URL. */
  exact: boolean;
  /** HTTP method (uppercased) declared by the wrapper. */
  httpMethod: string | null;
  /** Static parts of the URL (when the resolution stays a template). */
  templateParts: string[] | null;
  /**
   * If the call site's first argument is a literal, the value (e.g.
   * the request name on a `client.post('GenerateBundle', body)` call).
   * Useful in evidence/debug.
   */
  firstArgLiteral: string | null;
}

/**
 * Try to resolve a `<receiver>.<method>(args...)` call site as a
 * fetch-wrapper invocation. Returns `null` when the call doesn't fit
 * the wrapper shape or any required link can't be statically resolved.
 */
export function resolveWrapperCall(call: CallExpression): WrapperResolution | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;

  const methodName = callee.getNameNode().getText();
  // Cheap negative gate before hitting ts-morph symbol resolution.
  // The full check is "does the method's body contain a fetch call?",
  // performed below.
  if (NEVER_WRAPPER_METHOD_NAMES.has(methodName)) return null;

  const receiver = callee.getExpression();
  const cls = resolveReceiverClass(receiver);
  if (!cls) return null;

  const method = findMethodOnClass(cls, methodName);
  if (!method) return null;

  // Two recognized wrapper shapes:
  //   1. Method body contains a `fetch(...)` call (the original
  //      framework-fetch wrapper-resolver shape).
  //   2. #196 — URL-builder methods: body just returns a URL string.
  //      The user later passes the URL to `<a href>`,
  //      `window.location.assign`, etc. These are still client-side
  //      API callers and deserve a `ClientSideAPICaller` node.
  let innerUrlExpr: Expression | null = null;
  let innerOptions: Expression | null = null;
  let urlBuilderHttpMethod: string | null = null;

  const innerFetch = findInnerFetchCall(method);
  if (innerFetch) {
    const innerArgs = innerFetch.getArguments();
    if (innerArgs.length === 0) return null;
    innerUrlExpr = innerArgs[0] as Expression;
    innerOptions = innerArgs.length > 1 ? (innerArgs[1] as Expression) : null;
  } else {
    // URL-builder fallback: look for `return <urlExpr>` where
    // <urlExpr> is a string literal or URL-shaped template.
    const returned = findUrlBuilderReturnExpression(method);
    if (!returned) return null;
    innerUrlExpr = returned;
    // No HTTP method in a URL builder — default to GET. Most common
    // shape is a download URL passed to `<a href>` or
    // `location.assign`, both of which are GETs.
    urlBuilderHttpMethod = 'GET';
  }
  if (!innerUrlExpr) return null;

  // Build the substitution map.
  const ctorArgs = constructorArgsFromInstance(receiver);
  const callArgs = call.getArguments() as Expression[];
  const methodParams = method.getParameters();
  // Find the constructor: leaf class first, then walk up the
  // inheritance chain (#207). A subclass with no own constructor
  // inherits the base's, and the base's parameter properties are
  // what bind `this.url` to the call-site argument.
  const ctor = findConstructorWithChain(cls);

  const subs: Substitutions = {
    thisFields: ctorArgs ? buildThisFieldMap(ctor, ctorArgs) : new Map(),
    methodParams: buildMethodParamMap(methodParams, callArgs),
  };

  const urlResolution = resolveTemplate(innerUrlExpr, subs);
  if (!urlResolution) return null;

  // For URL-builder mode, the post-substitution string must look
  // like a URL. Filters out non-URL string returns (labels, JSON
  // blobs, formatted display strings) that happen to ride the same
  // class.
  if (urlBuilderHttpMethod !== null && urlResolution.value !== null) {
    if (!startsLikeUrl(urlResolution.value)) return null;
  }

  const httpMethod = urlBuilderHttpMethod ?? inferHttpMethod(innerOptions, methodName);

  return {
    urlLiteral: urlResolution.value,
    exact: urlResolution.exact,
    httpMethod,
    templateParts: urlResolution.parts,
    firstArgLiteral: stringLiteralValue(callArgs[0]),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Receiver → class resolution
// ──────────────────────────────────────────────────────────────────────

function resolveReceiverClass(receiver: Expression): ClassDeclaration | ClassExpression | null {
  // First-line approach: use ts-morph's type system to find the
  // class for the receiver's type. Works for any binding shape
  // (variable, this.field, parameter property, etc.) without us
  // having to walk syntactic chains, AND it works across path-mapped
  // / workspace-aliased imports because the type checker has already
  // resolved them.
  const typeBased = resolveExpressionTypeToClass(receiver);
  if (typeBased) return typeBased;

  // Fall back to construction-site walking when the type system
  // can't help (e.g. type is widened to `any` because a workspace
  // import couldn't be resolved).
  const newExpr = findInstanceConstructionSite(receiver);
  if (!newExpr) return null;
  const ctorTarget = newExpr.getExpression();
  if (!Node.isIdentifier(ctorTarget)) return null;
  return resolveIdentifierToClass(ctorTarget);
}

/**
 * Use the ts-morph type checker to resolve `expr` to its class
 * declaration. Bypasses our manual import-walking and works across
 * any syntactic shape — including types whose original declaration
 * is in another file behind a path-mapped or workspace import.
 *
 * Returns null if the type isn't a class type or the declaration
 * can't be located (e.g. because the import didn't physically
 * resolve and the type was widened to `any`).
 */
function resolveExpressionTypeToClass(
  expr: Expression,
): ClassDeclaration | ClassExpression | null {
  const getType = (expr as { getType?: () => unknown }).getType;
  if (typeof getType !== 'function') return null;
  let type: unknown;
  try {
    type = getType.call(expr);
  } catch {
    return null;
  }
  if (!type) return null;
  const sym = (type as { getSymbol?: () => unknown }).getSymbol?.();
  if (!sym) return null;
  const getDecls = (sym as { getDeclarations?: () => Node[] }).getDeclarations;
  if (typeof getDecls !== 'function') return null;
  for (const decl of getDecls.call(sym)) {
    if (Node.isClassDeclaration(decl) || Node.isClassExpression(decl)) {
      return decl;
    }
  }
  return null;
}

/**
 * Resolve an identifier (e.g. the callee of a `new ClassName(...)`)
 * to its `ClassDeclaration` / `ClassExpression`. Follows import
 * aliases — both via `getAliasedSymbol()` when available and via
 * explicit `getModuleSpecifierSourceFile()` traversal — so a class
 * imported from another file still resolves to its original
 * declaration.
 */
function resolveIdentifierToClass(
  id: Expression,
): ClassDeclaration | ClassExpression | null {
  if (!Node.isIdentifier(id)) return null;
  const visited = new Set<Node>();
  return resolveIdentifierToClassInner(id, visited);
}

function resolveIdentifierToClassInner(
  id: Expression,
  visited: Set<Node>,
): ClassDeclaration | ClassExpression | null {
  if (!Node.isIdentifier(id)) return null;
  const symbol = id.getSymbol();
  if (!symbol) return null;

  // Direct: class declaration in scope.
  for (const decl of symbol.getDeclarations()) {
    if (visited.has(decl)) continue;
    visited.add(decl);
    if (Node.isClassDeclaration(decl) || Node.isClassExpression(decl)) {
      return decl;
    }
  }

  // Aliased symbol (cheap path when ts-morph exposes the alias graph).
  const maybeAlias = (symbol as { getAliasedSymbol?: () => typeof symbol })
    .getAliasedSymbol;
  if (typeof maybeAlias === 'function') {
    let aliased: typeof symbol | undefined;
    try {
      aliased = maybeAlias.call(symbol);
    } catch {
      aliased = undefined;
    }
    if (aliased && aliased !== symbol) {
      for (const decl of aliased.getDeclarations()) {
        if (visited.has(decl)) continue;
        visited.add(decl);
        if (Node.isClassDeclaration(decl) || Node.isClassExpression(decl)) {
          return decl;
        }
      }
    }
  }

  // Explicit import traversal — walk each ImportSpecifier /
  // ImportClause / NamespaceImport declaration to the target file's
  // exported binding and recurse.
  for (const decl of symbol.getDeclarations()) {
    if (
      !Node.isImportSpecifier(decl) &&
      !Node.isImportClause(decl) &&
      !Node.isNamespaceImport(decl)
    ) {
      continue;
    }
    let importDecl: Node | undefined = decl;
    while (importDecl && !Node.isImportDeclaration(importDecl)) {
      importDecl = importDecl.getParent();
    }
    if (!importDecl || !Node.isImportDeclaration(importDecl)) continue;
    const targetFile = importDecl.getModuleSpecifierSourceFile();
    if (!targetFile) continue;
    const exportName = Node.isImportSpecifier(decl)
      ? decl.getName()
      : Node.isImportClause(decl)
      ? 'default'
      : null;
    if (!exportName) continue;
    const exported = targetFile.getExportedDeclarations().get(exportName);
    if (!exported) continue;
    for (const e of exported) {
      if (visited.has(e)) continue;
      visited.add(e);
      if (Node.isClassDeclaration(e) || Node.isClassExpression(e)) return e;
    }
  }

  return null;
}

function constructorArgsFromInstance(receiver: Expression): Expression[] | null {
  const newExpr = findInstanceConstructionSite(receiver);
  if (!newExpr) return null;
  return newExpr.getArguments() as Expression[];
}

/**
 * Find the `new ClassName(...)` expression that produced the value
 * bound to `receiver`. Handles three increasingly indirect cases:
 *
 *   - `const x = new C(...)` — variable initializer.
 *   - `class S { x = new C(...) }` — class field initializer.
 *   - `class S { x: T; constructor() { this.x = new C(...) } }` —
 *     constructor body assignment, the most common shape for
 *     dependency-injected wrappers (e.g. an `API` class that wraps a
 *     `PostAPIClient`).
 */
function findInstanceConstructionSite(receiver: Expression) {
  if (!Node.isIdentifier(receiver) && !Node.isPropertyAccessExpression(receiver)) return null;
  const symbol = receiver.getSymbol?.();
  if (!symbol) return null;
  for (const decl of symbol.getDeclarations()) {
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && Node.isNewExpression(init)) return init;
    }
    if (Node.isPropertyDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && Node.isNewExpression(init)) return init;
      // Field declared without an initializer — look for an
      // assignment in the enclosing class's constructor.
      const cls = decl.getFirstAncestor(
        (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
      );
      const fieldName = decl.getName();
      if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
        const found = findFieldNewAssignment(cls, fieldName);
        if (found) return found;
      }
    }
  }
  return null;
}

function findFieldNewAssignment(
  cls: ClassDeclaration | ClassExpression,
  fieldName: string,
) {
  for (const member of cls.getMembers()) {
    if (!Node.isConstructorDeclaration(member) && !Node.isMethodDeclaration(member)) continue;
    const body = member.getBody();
    if (!body) continue;
    let result: Node | null = null;
    body.forEachDescendant((d, traversal) => {
      if (result) {
        traversal.stop();
        return;
      }
      if (!Node.isBinaryExpression(d)) return;
      if (d.getOperatorToken().getText() !== '=') return;
      const left = d.getLeft();
      if (!Node.isPropertyAccessExpression(left)) return;
      if (!Node.isThisExpression(left.getExpression())) return;
      if (left.getNameNode().getText() !== fieldName) return;
      const right = d.getRight();
      if (Node.isNewExpression(right)) {
        result = right;
        traversal.stop();
      }
    });
    if (result && Node.isNewExpression(result)) return result;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Method discovery
// ──────────────────────────────────────────────────────────────────────

/**
 * Find the constructor for a class, walking inheritance when the
 * leaf class has no own ctor (#207). Symmetric with
 * `findMethodOnClass`'s base-class walk: a subclass like
 * `class UserAPI extends BasePostClient {}` has an empty
 * `getConstructors()` and inherits its base's parameter properties.
 */
function findConstructorWithChain(
  cls: ClassDeclaration | ClassExpression,
  visited: Set<ClassDeclaration | ClassExpression> = new Set(),
): ConstructorDeclaration | null {
  if (visited.has(cls)) return null;
  visited.add(cls);
  const own = cls.getConstructors()[0];
  if (own) return own;
  const getBase = (cls as ClassDeclaration).getBaseClass;
  if (typeof getBase === 'function') {
    const baseClass = getBase.call(cls);
    if (baseClass) return findConstructorWithChain(baseClass, visited);
  }
  return null;
}

/**
 * Find a method by name on a class, walking the inheritance chain
 * via `getBaseClass()` when not found on `cls` itself (#207). The
 * common "shared base API client + per-domain subclasses" pattern —
 * `class UserAPI extends BaseAPIClient` — would otherwise produce
 * zero callers because `cls.getMembers()` is empty for the leaf
 * subclass.
 *
 * Own-member match wins over inherited (overrides take precedence).
 * Visited-set guards against pathological inheritance cycles.
 */
function findMethodOnClass(
  cls: ClassDeclaration | ClassExpression,
  methodName: string,
  visited: Set<ClassDeclaration | ClassExpression> = new Set(),
): MethodDeclaration | null {
  if (visited.has(cls)) return null;
  visited.add(cls);

  // Own members first — overrides win.
  for (const member of cls.getMembers()) {
    if (Node.isMethodDeclaration(member) && member.getName() === methodName) {
      return member;
    }
  }

  // Walk up the inheritance chain via ts-morph's getBaseClass().
  // Returns the immediate base; recursion handles deeper chains.
  // ClassExpression also has getBaseClass via the same prototype.
  const getBase = (cls as ClassDeclaration).getBaseClass;
  if (typeof getBase === 'function') {
    const baseClass = getBase.call(cls);
    if (baseClass) {
      return findMethodOnClass(baseClass, methodName, visited);
    }
  }

  return null;
}

/**
 * Find a single `fetch(...)` call inside a method body. We accept the
 * common shapes — direct call, `return fetch(...)`, `await fetch(...)`,
 * `return await fetch(...)`, and `const r = fetch(...)` — but require
 * exactly one fetch call. Methods that branch into multiple fetch
 * calls are skipped (we'd need per-branch resolution).
 */
function findInnerFetchCall(method: MethodDeclaration): CallExpression | null {
  const body = method.getBody();
  if (!body) return null;
  let found: CallExpression | null = null;
  let multiple = false;
  body.forEachDescendant((node, traversal) => {
    if (multiple) {
      traversal.stop();
      return;
    }
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === 'fetch') {
      if (found) {
        multiple = true;
        traversal.stop();
        return;
      }
      found = node;
    }
  });
  return multiple ? null : found;
}

/**
 * #196 — URL-builder method shape: the body returns a URL string.
 *
 * Accepted shapes (after peeling `await`):
 *   - `return <stringLiteral>` where the value matches a URL prefix.
 *   - `return <noSubstitutionTemplate>` (same).
 *   - `return <templateExpression>` whose head literal looks URL-ish.
 *
 * URL-shape filter (cheap structural check) — the literal value or
 * template head must start with one of:
 *   - `/`             — path-relative (`/api/...`, `/v1/...`, `/`).
 *   - `http://` / `https://` — fully qualified.
 *
 * Methods whose return is a non-URL string (e.g., a label, a JSON
 * blob, a CSS class name) are excluded.
 */
function findUrlBuilderReturnExpression(method: MethodDeclaration): Expression | null {
  const body = method.getBody();
  if (!body) return null;
  let found: Expression | null = null;
  let multiple = false;
  body.forEachDescendant((node, traversal) => {
    if (multiple) {
      traversal.stop();
      return;
    }
    if (!Node.isReturnStatement(node)) return;
    let expr: Expression | undefined = node.getExpression();
    if (!expr) return;
    if (Node.isAwaitExpression(expr)) {
      const inner = expr.getExpression();
      if (inner) expr = inner;
    }
    if (!isStringShapedExpression(expr)) return;
    if (found) {
      multiple = true;
      traversal.stop();
      return;
    }
    found = expr;
  });
  return multiple ? null : found;
}

/**
 * Cheap pre-substitution shape check: is the expression a string
 * literal or template? URL-shape (must start with `/`, `http://`,
 * `https://`) is verified post-substitution in
 * `resolveWrapperCall` so templates whose head is empty (e.g.,
 * `${this.base}/foo`) can still resolve.
 */
function isStringShapedExpression(expr: Expression): boolean {
  return (
    Node.isStringLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr) ||
    Node.isTemplateExpression(expr)
  );
}

function startsLikeUrl(s: string): boolean {
  return s.startsWith('/') || s.startsWith('http://') || s.startsWith('https://');
}

// ──────────────────────────────────────────────────────────────────────
// Substitution
// ──────────────────────────────────────────────────────────────────────

interface Substitutions {
  /** `this.<field>` → constructor arg expression bound to that field. */
  thisFields: Map<string, Expression>;
  /** method-param name → call-site arg expression. */
  methodParams: Map<string, Expression>;
}

function buildThisFieldMap(
  ctor: ConstructorDeclaration | null,
  ctorArgs: readonly Expression[],
): Map<string, Expression> {
  const map = new Map<string, Expression>();
  if (!ctor) return map;
  const params = ctor.getParameters();

  // Parameter properties: `constructor(private url: string)` → field name === param name.
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    const arg = ctorArgs[i];
    if (!arg) continue;
    if (isParameterProperty(p)) {
      map.set(p.getName(), arg);
    }
  }

  // Build a lookup from "name visible inside the constructor body"
  // to the corresponding call-site argument expression. Handles:
  //   - Plain params: `(url: string)` → name "url" maps to arg.
  //   - Destructured object param: `({ url }: { url: string })` —
  //     name "url" maps to the corresponding property of the
  //     object-literal arg, if the call site provided one.
  const localToArg = new Map<string, Expression>();
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    const arg = ctorArgs[i];
    if (!arg) continue;
    const nameNode = p.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      localToArg.set(nameNode.getText(), arg);
    } else if (Node.isObjectBindingPattern(nameNode) && Node.isObjectLiteralExpression(arg)) {
      // Match each binding element to a property of the call-site
      // object literal.
      for (const elem of nameNode.getElements()) {
        const propName = (elem.getPropertyNameNode()?.getText() ?? elem.getNameNode().getText());
        const localName = elem.getNameNode().getText();
        const propExpr = pickObjectLiteralProperty(arg, propName);
        if (propExpr) localToArg.set(localName, propExpr);
      }
    }
  }

  // Constructor body assignments: `this.<x> = <expr>` where <expr> is
  // a name visible in the constructor body (parameter, destructured
  // binding, etc.).
  const body = ctor.getBody();
  if (body) {
    body.forEachDescendant((d) => {
      if (!Node.isBinaryExpression(d)) return;
      if (d.getOperatorToken().getText() !== '=') return;
      const left = d.getLeft();
      if (!Node.isPropertyAccessExpression(left)) return;
      if (!Node.isThisExpression(left.getExpression())) return;
      const fieldName = left.getNameNode().getText();
      const right = d.getRight();
      if (!Node.isIdentifier(right)) return;
      const bound = localToArg.get(right.getText());
      if (bound) map.set(fieldName, bound);
    });
  }
  return map;
}

function pickObjectLiteralProperty(
  obj: Expression,
  name: string,
): Expression | null {
  if (!Node.isObjectLiteralExpression(obj)) return null;
  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const nameNode = prop.getNameNode();
      const propName = Node.isIdentifier(nameNode)
        ? nameNode.getText()
        : Node.isStringLiteral(nameNode)
        ? nameNode.getLiteralValue()
        : '';
      if (propName === name) {
        const init = prop.getInitializer();
        return init ?? null;
      }
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      if (prop.getName() === name) {
        // Shorthand `{ url }` — value is an identifier; we'd need
        // another lookup pass. Skip for now (rare in practice for
        // base-URL style configuration).
        return null;
      }
    }
  }
  return null;
}

function buildMethodParamMap(
  methodParams: readonly ParameterDeclaration[],
  callArgs: readonly Expression[],
): Map<string, Expression> {
  const map = new Map<string, Expression>();
  for (let i = 0; i < methodParams.length; i++) {
    const arg = callArgs[i];
    if (!arg) continue;
    map.set(methodParams[i]!.getName(), arg);
  }
  return map;
}

function isParameterProperty(p: ParameterDeclaration): boolean {
  // ts-morph exposes scope (`public`/`private`/`protected`) and `readonly`
  // on parameters that are ALSO instance fields.
  return Boolean(p.getScope?.() && p.getScope() !== 'public' /* default */) ||
    p.hasModifier?.('public') === true ||
    p.hasModifier?.('private') === true ||
    p.hasModifier?.('protected') === true ||
    p.hasModifier?.('readonly') === true;
}

// ──────────────────────────────────────────────────────────────────────
// Template resolution
// ──────────────────────────────────────────────────────────────────────

interface TemplateResolution {
  /** Resolved URL string when fully literal; otherwise the static prefix. */
  value: string | null;
  /** True when no dynamic spans remain after substitution. */
  exact: boolean;
  /** Static parts of the template, in order. */
  parts: string[];
}

function resolveTemplate(expr: Expression, subs: Substitutions): TemplateResolution | null {
  // Plain literal URL.
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    const v = expr.getLiteralValue();
    return { value: v, exact: true, parts: [v] };
  }

  if (Node.isTemplateExpression(expr)) {
    return resolveTemplateExpression(expr, subs);
  }

  return null;
}

function resolveTemplateExpression(
  expr: TemplateExpression,
  subs: Substitutions,
): TemplateResolution {
  const headText = expr.getHead().getLiteralText();
  const spans = expr.getTemplateSpans();
  let exact = true;
  const literalParts: string[] = [headText];
  let assembled = headText;

  for (const span of spans) {
    const spanExpr = span.getExpression();
    const literalSuffix = span.getLiteral().getLiteralText();
    const subbed = substituteSpan(spanExpr, subs);
    if (subbed !== null) {
      assembled += subbed + literalSuffix;
    } else {
      exact = false;
      assembled += literalSuffix; // skip the dynamic span; record only static suffix
    }
    literalParts.push(literalSuffix);
  }

  // Even when not fully exact, the assembled string up to the last
  // resolved span is the most useful URL prefix we have — emit it
  // verbatim so the stitcher can pattern-match against route shapes
  // like `/api/jade?r=:request_name`. Falls back to null only when no
  // substring is statically known at all.
  return {
    value: assembled !== '' ? assembled : null,
    exact,
    parts: literalParts,
  };
}

function substituteSpan(expr: Expression, subs: Substitutions): string | null {
  // `this.<x>` → look up the bound constructor arg.
  if (Node.isPropertyAccessExpression(expr) && Node.isThisExpression(expr.getExpression())) {
    const field = expr.getNameNode().getText();
    const bound = subs.thisFields.get(field);
    if (bound) return literalValue(bound);
    return null;
  }
  // `<methodParam>` → look up the call-site arg.
  if (Node.isIdentifier(expr)) {
    const bound = subs.methodParams.get(expr.getText());
    if (bound) return literalValue(bound);
    return null;
  }
  // `String(<expr>)`, `Number(<expr>)`, `Boolean(<expr>)` — coercion
  // wrappers the wrapper author may use for type-system reasons.
  // Peel the wrapper and try the inner expression.
  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isIdentifier(callee)) {
      const name = callee.getText();
      if (name === 'String' || name === 'Number' || name === 'Boolean') {
        const inner = expr.getArguments()[0];
        if (inner && Node.isExpression(inner)) {
          return substituteSpan(inner, subs);
        }
      }
    }
  }
  return null;
}

function literalValue(expr: Expression): string | null {
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getLiteralValue();
  }
  return null;
}

function stringLiteralValue(expr: Expression | undefined): string | null {
  if (!expr) return null;
  return literalValue(expr);
}

// ──────────────────────────────────────────────────────────────────────
// HTTP method extraction
// ──────────────────────────────────────────────────────────────────────

function inferHttpMethod(options: Expression | null, methodName: string): string | null {
  if (options && Node.isObjectLiteralExpression(options)) {
    for (const prop of options.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const nameNode = prop.getNameNode();
      const name = Node.isIdentifier(nameNode)
        ? nameNode.getText()
        : Node.isStringLiteral(nameNode)
        ? nameNode.getLiteralValue()
        : '';
      if (name !== 'method') continue;
      const init = prop.getInitializer();
      if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
        return init.getLiteralValue().toUpperCase();
      }
      return null;
    }
  }
  // Fall back to the wrapper method name when it matches an HTTP verb
  // (`client.post(...)` clearly intends POST even if `options.method`
  // wasn't statically resolvable).
  const upper = methodName.toUpperCase();
  if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(upper)) {
    return upper;
  }
  return null;
}
