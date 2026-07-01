import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller, type HttpEgressConfidence } from '@veoable/schema';
import { detectExternalUrl } from '@veoable/plugin-api';
import type { GoFrameworkVisitor, GoVisitContext } from '@veoable/lang-go';

/**
 * Go net/http + Echo + Fiber framework visitor (#23).
 *
 * Detects API endpoints from three patterns:
 *
 * 1. **net/http** (standard library):
 *    - `http.HandleFunc("GET /users/{id}", handler)` — Go 1.22+ with method prefix
 *    - `mux.HandleFunc("/legacy", handler)` — pre-1.22, all methods
 *    - `http.Handle("/path", handler)` — interface-based
 *    - Path params: `{id}`, `{path...}` → normalized to `:id`, `:path`
 *    - Heuristic: any receiver with `HandleFunc`/`Handle` method is matched
 *      when `net/http` is imported. This could false-positive on user-defined
 *      types with the same method name, but is unlikely in practice.
 *
 * 2. **Echo** (`github.com/labstack/echo`):
 *    - `e.GET("/path", handler)` — uppercase HTTP methods
 *    - Only matched when Echo is imported AND Gin is NOT imported,
 *      to avoid collision (M1 fix). Both use uppercase method names.
 *
 * 3. **Fiber** (`github.com/gofiber/fiber`):
 *    - `app.Get("/path", handler)` — titlecase HTTP methods
 *    - No collision risk with Gin (different casing).
 *
 * TODO: Handler resolution — `handlerFunctionId` is always null.
 *   Go handler functions are typically named identifiers resolvable from
 *   the AST, but this requires integration with lang-go's function
 *   registry which is not yet exposed to visitors.
 */

const HTTP_HANDLER_METHODS: ReadonlySet<string> = new Set([
  'HandleFunc', 'Handle',
]);

const ECHO_METHODS: ReadonlySet<string> = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
]);

const FIBER_METHODS: ReadonlySet<string> = new Set([
  'Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options',
]);

const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

// ── Client-side (net/http) ────────────────────────────────────────
//
// `http.Get(url)` → GET, `http.Post(url, contentType, body)` → POST,
// `http.Head(url)` → HEAD, `http.PostForm(url, values)` → POST.
// These are the only top-level convenience functions in net/http.
const NET_HTTP_TOP_LEVEL: ReadonlyMap<string, string> = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['PostForm', 'POST'],
  ['Head', 'HEAD'],
]);

// Method-chain forms on an *http.Client. net/http's Client has only
// Get/Post/PostForm/Head shortcuts; Put/Patch/Delete go through Do.
const HTTP_CLIENT_METHODS: ReadonlyMap<string, string> = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['PostForm', 'POST'],
  ['Head', 'HEAD'],
]);

// Receiver names that look like an *http.Client. Aligned with
// framework-httpx's RECEIVER_RE for cross-language parity. The
// file-level `net/http` import gate keeps this from false-
// positive-ing on unrelated `.Get(...)` calls in files that don't
// import net/http.
const HTTP_CLIENT_RECEIVER_RE = /^(?:.*(?:client|http|api).*)$/i;

export function createGoHttpVisitor(): GoFrameworkVisitor {
  const fileImportCache = new Map<string, { hasHttp: boolean; hasEcho: boolean; hasFiber: boolean; hasGin: boolean }>();

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;

      const fnNode = node.childForFieldName('function');
      if (!fnNode || fnNode.type !== 'selector_expression') return;

      const field = fnNode.childForFieldName('field');
      const operand = fnNode.childForFieldName('operand');
      if (!field || !operand) return;

      const methodName = field.text;
      const receiverText = operand.text;

      const imports = getFileImports(node, ctx.sourceFile.filePath, fileImportCache);

      // ── net/http: HandleFunc / Handle ──────────────────────────────
      if (HTTP_HANDLER_METHODS.has(methodName) && imports.hasHttp) {
        const args = node.childForFieldName('arguments');
        if (!args) return;

        const patternStr = findFirstStringArg(args);
        if (!patternStr) return;

        const { method, path } = parseHttpPattern(patternStr);
        const routePattern = path.replace(/\{(\w+)(?:\.\.\.)?\}/g, ':$1');

        emitEndpoint(ctx, node, method, routePattern, 'gohttp');
        return;
      }

      // ── Echo: e.GET("/path", handler) ──────────────────────────────
      // M1 fix: only match Echo if Gin is NOT imported
      if (ECHO_METHODS.has(methodName) && imports.hasEcho && !imports.hasGin) {
        if (receiverText === 'echo') return;

        const args = node.childForFieldName('arguments');
        if (!args) return;
        const pathStr = findFirstStringArg(args);
        if (!pathStr) return;

        emitEndpoint(ctx, node, methodName, pathStr, 'echo');
        return;
      }

      // ── Fiber: app.Get("/path", handler) ───────────────────────────
      if (FIBER_METHODS.has(methodName) && imports.hasFiber) {
        if (receiverText === 'fiber') return;

        const args = node.childForFieldName('arguments');
        if (!args) return;
        const pathStr = findFirstStringArg(args);
        if (!pathStr) return;

        emitEndpoint(ctx, node, methodName.toUpperCase(), pathStr, 'fiber');
        return;
      }

      // ── Client-side net/http (outbound HTTP) ───────────────────────
      // The same call_expression dispatch handles both server-side
      // route registration (above) AND outbound calls. Conservatism
      // is provided by the file-level `net/http` import gate.
      if (!imports.hasHttp) return;
      if (!ctx.enclosingFunction) return;

      // 1. `http.Get(URL)` / `http.Post(URL, ...)` / `http.Head(URL)` /
      //    `http.PostForm(URL, values)` — top-level convenience.
      if (receiverText === 'http') {
        const httpMethod = NET_HTTP_TOP_LEVEL.get(methodName);
        if (httpMethod) {
          emitClientCaller(ctx, node, httpMethod, /* urlArgIndex */ 0);
          return;
        }
        // 2. `http.NewRequest("METHOD", URL, body)` — covers Put,
        //    Patch, Delete and other verbs that don't have shortcuts.
        if (methodName === 'NewRequest' || methodName === 'NewRequestWithContext') {
          const args = node.childForFieldName('arguments');
          if (!args) return;
          // NewRequest: (method, url, body). NewRequestWithContext:
          // (ctx, method, url, body).
          const methodLitIdx = methodName === 'NewRequest' ? 0 : 1;
          const urlLitIdx = methodLitIdx + 1;
          const method = readStringArg(args, methodLitIdx);
          if (!method || !VALID_HTTP_METHODS.has(method.toUpperCase())) return;
          emitClientCaller(ctx, node, method.toUpperCase(), urlLitIdx);
          return;
        }
      }

      // 3. `<receiver>.Get/Post/Head/PostForm(URL, ...)` on a client.
      if (HTTP_CLIENT_METHODS.has(methodName) && HTTP_CLIENT_RECEIVER_RE.test(receiverText)) {
        const httpMethod = HTTP_CLIENT_METHODS.get(methodName)!;
        emitClientCaller(ctx, node, httpMethod, /* urlArgIndex */ 0);
      }
    },
  };
}

function emitEndpoint(
  ctx: GoVisitContext,
  node: SyntaxNode,
  httpMethod: string,
  routePattern: string,
  framework: string,
): void {
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod,
      routePattern,
      filePath: ctx.sourceFile.filePath,
      lineStart: node.startPosition.row + 1,
    }),
    httpMethod,
    routePattern,
    handlerFunctionId: null,
    framework,
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      snippet: node.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(endpoint);
}

/**
 * Parse a Go 1.22+ HTTP pattern.
 * m6 fix: method must be exact uppercase (case-sensitive).
 */
function parseHttpPattern(pattern: string): { method: string; path: string } {
  const spaceIdx = pattern.indexOf(' ');
  if (spaceIdx > 0) {
    const method = pattern.slice(0, spaceIdx);
    if (VALID_HTTP_METHODS.has(method)) {
      return { method, path: pattern.slice(spaceIdx + 1) };
    }
  }
  return { method: 'ALL', path: pattern };
}

function getFileImports(
  node: SyntaxNode,
  filePath: string,
  cache: Map<string, { hasHttp: boolean; hasEcho: boolean; hasFiber: boolean; hasGin: boolean }>,
): { hasHttp: boolean; hasEcho: boolean; hasFiber: boolean; hasGin: boolean } {
  if (cache.has(filePath)) return cache.get(filePath)!;

  const sourceFile = node.tree.rootNode;
  let hasHttp = false, hasEcho = false, hasFiber = false, hasGin = false;

  for (let i = 0; i < sourceFile.childCount; i++) {
    const child = sourceFile.child(i)!;
    if (child.type === 'import_declaration') {
      const text = child.text;
      if (text.includes('"net/http"')) hasHttp = true;
      if (text.includes('labstack/echo')) hasEcho = true;
      if (text.includes('gofiber/fiber')) hasFiber = true;
      if (text.includes('gin-gonic/gin')) hasGin = true;
    }
  }

  const result = { hasHttp, hasEcho, hasFiber, hasGin };
  cache.set(filePath, result);
  return result;
}

function findFirstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (child.type === 'interpreted_string_literal' || child.type === 'raw_string_literal') {
      return child.text.slice(1, -1);
    }
  }
  return null;
}

/**
 * Return the Nth non-punctuation child of an `argument_list`. Index
 * counts only real arguments, skipping `(`, `,`, `)`.
 */
function nthArg(args: SyntaxNode, index: number): SyntaxNode | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === index) return c;
    seen++;
  }
  return null;
}

/**
 * Read the Nth argument as a string literal (interpreted or raw),
 * or null if it's anything else.
 */
function readStringArg(args: SyntaxNode, index: number): string | null {
  const arg = nthArg(args, index);
  if (!arg) return null;
  if (arg.type === 'interpreted_string_literal' || arg.type === 'raw_string_literal') {
    return arg.text.slice(1, -1);
  }
  return null;
}

function emitClientCaller(
  ctx: GoVisitContext,
  callNode: SyntaxNode,
  httpMethod: string,
  urlArgIndex: number,
): void {
  if (!ctx.enclosingFunction) return;
  const args = callNode.childForFieldName('arguments');
  if (!args) return;

  const urlArg = nthArg(args, urlArgIndex);
  const { urlLiteral, egressConfidence } = resolveUrlArg(urlArg);

  const sourceLine = callNode.startPosition.row + 1;
  const ext = urlLiteral ? detectExternalUrl(urlLiteral) : { isExternal: false, host: null };

  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      urlLiteral,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    httpMethod,
    urlLiteral,
    egressConfidence,
    framework: 'gohttp',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: sourceLine,
      lineEnd: callNode.endPosition.row + 1,
      snippet: callNode.text.slice(0, 200),
      confidence: egressConfidence === 'exact' ? ('exact' as const) : ('heuristic' as const),
    },
    ...(ext.isExternal ? { isExternal: true, externalHost: ext.host } : {}),
  };
  ctx.emitNode(caller);
  ctx.emitEdge({
    edgeType: 'MAKES_REQUEST',
    from: ctx.enclosingFunction.id,
    to: caller.id,
  });
}

function resolveUrlArg(arg: SyntaxNode | null): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (!arg) return { urlLiteral: null, egressConfidence: 'dynamic' };
  if (arg.type === 'interpreted_string_literal' || arg.type === 'raw_string_literal') {
    return { urlLiteral: arg.text.slice(1, -1), egressConfidence: 'exact' };
  }
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}
