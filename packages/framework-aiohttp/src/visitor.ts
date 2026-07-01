import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller, type HttpEgressConfidence } from '@veoable/schema';
import { detectExternalUrl } from '@veoable/plugin-api';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

/**
 * aiohttp visitor — server + client in one pass.
 *
 * SERVER-SIDE shapes:
 *
 *   1. Decorator on a RouteTableDef:
 *        routes = web.RouteTableDef()
 *        @routes.get('/users')
 *        async def get_users(request): ...
 *
 *   2. `app.router.add_<verb>('/path', handler)` call:
 *        app.router.add_get('/users', get_users)
 *        app.router.add_post('/users', create_user)
 *
 *   3. Constructor-form route inside `app.add_routes([...])`:
 *        app.add_routes([web.get('/users', h), web.post(...)])
 *
 *   4. Class-based view (`class X(web.View)`):
 *        class UserView(web.View):
 *            async def get(self): ...
 *            async def post(self): ...
 *      Each HTTP-verb method emits at the class's `routes.view(URL)`
 *      registration. v1 limit: we DO emit one endpoint per verb
 *      method, but the route URL comes from the registration site;
 *      if the class is registered without a URL we use the class
 *      name as a fallback heuristic.
 *
 * CLIENT-SIDE shape:
 *
 *   async with aiohttp.ClientSession() as session:
 *       async with session.get('https://...') as resp: ...
 *       await session.post('https://...', json=body)
 *
 *   Method-call shape gated on aiohttp import; receiver heuristic
 *   uses the same /session|client|http|api/ regex as httpx/gohttp.
 */

const HTTP_VERBS_LOWER: ReadonlyMap<string, string> = new Map([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['delete', 'DELETE'],
  ['patch', 'PATCH'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
]);

const ADD_VERB_RE = /^add_(get|post|put|delete|patch|head|options)$/;

const CLIENT_RECEIVER_RE = /^(?:self\.)?(?:.*(?:client|http|api|session|aiohttp).*)$/i;

interface FileFlags {
  importsAiohttp: boolean;
}

export function createAiohttpVisitor(): PyFrameworkVisitor {
  const flagsByFile = new Map<string, FileFlags>();
  const getFlags = (filePath: string, root: SyntaxNode): FileFlags => {
    let f = flagsByFile.get(filePath);
    if (!f) {
      f = scanModuleImports(root);
      flagsByFile.set(filePath, f);
    }
    return f;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      const flags = getFlags(ctx.sourceFile.filePath, node.tree.rootNode);
      if (!flags.importsAiohttp) return;

      // ── Server-side: decorated_definition with @<recv>.<verb>("/path") ──
      if (node.type === 'decorated_definition') {
        handleDecoratedDef(ctx, node);
        return;
      }

      // ── Server-side: class_definition inheriting from `web.View` ────
      if (node.type === 'class_definition') {
        handleViewClass(ctx, node);
        return;
      }

      // ── Server-side: app.router.add_<verb>(URL, handler)            ──
      // ── + web.<verb>(URL, handler) constructor-form                  ──
      // ── Client-side: <session>.<verb>(URL)                           ──
      if (node.type === 'call') {
        handleCall(ctx, node);
        return;
      }
    },
  };
}

function handleDecoratedDef(ctx: PyVisitContext, node: SyntaxNode): void {
  const decorators = node.children.filter((c) => c.type === 'decorator');
  const fnDef = node.childForFieldName('definition');
  if (!fnDef || fnDef.type !== 'function_definition') return;

  for (const dec of decorators) {
    const parsed = parseRouteDecorator(dec);
    if (!parsed) continue;

    const nameNode = fnDef.childForFieldName('name');
    const fnName = nameNode?.text ?? 'handler';
    const fnLine = fnDef.startPosition.row + 1;

    emitRoute(ctx, dec, parsed.method, parsed.path, fnName, fnLine);
  }
}

interface RouteDecoratorResult {
  method: string;
  path: string;
}

function parseRouteDecorator(decorator: SyntaxNode): RouteDecoratorResult | null {
  // Walk decorator's children for a `call` node.
  let callNode: SyntaxNode | null = null;
  for (const c of decorator.children) {
    if (c.type === 'call') {
      callNode = c;
      break;
    }
  }
  if (!callNode) return null;

  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return null;
  const attr = fn.childForFieldName('attribute');
  const obj = fn.childForFieldName('object');
  if (!attr || !obj) return null;

  const verb = HTTP_VERBS_LOWER.get(attr.text.toLowerCase());
  if (!verb) return null;

  // Receiver `obj` must look like a route table — `routes`, a
  // suffix like `*_routes`, or `route_table`. Tightens against
  // FastAPI's `@app.get(...)` if a file accidentally imports both.
  if (obj.type !== 'identifier') return null;
  if (!/route/i.test(obj.text)) return null;

  const args = callNode.childForFieldName('arguments');
  if (!args) return null;
  const path = firstStringArg(args);
  if (!path) return null;
  return { method: verb, path };
}

function handleViewClass(ctx: PyVisitContext, node: SyntaxNode): void {
  const supers = node.childForFieldName('superclasses');
  if (!supers) return;
  if (!hasWebViewSuperclass(supers)) return;

  const nameNode = node.childForFieldName('name');
  const className = nameNode?.text;
  if (!className) return;

  const body = node.childForFieldName('body');
  if (!body) return;

  // Use the class name as the synthetic route fallback. Actual URL
  // comes from `routes.view(URL)` / `app.router.add_view(URL,
  // ViewClass)` — v1 leaves URL resolution as a follow-up and uses
  // a class-scoped route pattern instead.
  const syntheticRoute = `/view/${className}`;

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;
    const methodNode = extractMethod(child);
    if (!methodNode) continue;

    const methodNameNode = methodNode.childForFieldName('name');
    const methodName = methodNameNode?.text;
    if (!methodName) continue;
    const verb = HTTP_VERBS_LOWER.get(methodName.toLowerCase());
    if (!verb) continue;

    const methodLine = methodNode.startPosition.row + 1;
    // Synthetic URL — actual registration site (routes.view(URL, Cls)
    // or app.router.add_view) isn't traced yet. Stamp 'heuristic'
    // confidence so flow-stitcher can overwrite later.
    emitRoute(ctx, methodNode, verb, syntheticRoute, `${className}.${methodName}`, methodLine, 'heuristic');
  }
}

function hasWebViewSuperclass(supers: SyntaxNode): boolean {
  for (let i = 0; i < supers.childCount; i++) {
    const c = supers.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    const text = lastDottedSegment(c.text);
    if (text === 'View') return true;
  }
  return false;
}

function handleCall(ctx: PyVisitContext, node: SyntaxNode): void {
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return;
  const obj = fn.childForFieldName('object');
  const attr = fn.childForFieldName('attribute');
  if (!obj || !attr) return;

  const methodName = attr.text;
  const args = node.childForFieldName('arguments');

  // Server-side: `app.router.add_<verb>(URL, handler)`.
  const addMatch = ADD_VERB_RE.exec(methodName);
  if (addMatch && args) {
    // Receiver should look like a router (contains `router` or be
    // the `app` itself when using app.add_get-style shortcuts).
    const receiverText = obj.text;
    if (/router|app/i.test(receiverText)) {
      const path = firstStringArg(args);
      if (path) {
        const verb = addMatch[1].toUpperCase();
        const handlerName = secondIdentifierArg(args);
        const handlerLine = node.startPosition.row + 1;
        emitRoute(ctx, node, verb, path, handlerName ?? 'handler', handlerLine);
        return;
      }
    }
  }

  // Server-side: `web.<verb>(URL, handler)` constructor form.
  if (
    obj.type === 'identifier'
    && obj.text === 'web'
    && HTTP_VERBS_LOWER.has(methodName.toLowerCase())
    && args
  ) {
    const path = firstStringArg(args);
    if (path) {
      const verb = HTTP_VERBS_LOWER.get(methodName.toLowerCase())!;
      const handlerName = secondIdentifierArg(args);
      const handlerLine = node.startPosition.row + 1;
      emitRoute(ctx, node, verb, path, handlerName ?? 'handler', handlerLine);
      return;
    }
  }

  // Client-side: `<session>.<verb>(URL)`.
  const clientVerb = HTTP_VERBS_LOWER.get(methodName.toLowerCase());
  if (clientVerb) {
    const receiverText = obj.text;
    // Top-level `aiohttp.request("METHOD", URL)` — bare module form
    // would be detected separately; here we focus on session chains.
    if (CLIENT_RECEIVER_RE.test(receiverText)) {
      if (!ctx.enclosingFunction || !args) return;
      const firstArg = firstPositionalArg(args);
      const { urlLiteral, egressConfidence } = resolveUrlArg(firstArg);
      emitClientCaller(ctx, node, clientVerb, urlLiteral, egressConfidence);
      return;
    }
  }
}

function emitRoute(
  ctx: PyVisitContext,
  evidenceNode: SyntaxNode,
  httpMethod: string,
  routePattern: string,
  handlerName: string,
  handlerLine: number,
  confidence: 'exact' | 'heuristic' = 'exact',
): void {
  const evidenceLine = evidenceNode.startPosition.row + 1;
  const handlerFunctionId = idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name: handlerName,
    sourceLine: handlerLine,
  });
  // Convert {name} path params to :name (Express-style).
  const normalized = routePattern.replace(/\{(\w+)(?::[^}]+)?\}/g, ':$1');

  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod,
      routePattern: normalized,
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
    }),
    httpMethod,
    routePattern: normalized,
    handlerFunctionId,
    framework: 'aiohttp',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
      lineEnd: evidenceNode.endPosition.row + 1,
      snippet: evidenceNode.text.slice(0, 200),
      confidence,
    },
  };
  ctx.emitNode(endpoint);
}

function emitClientCaller(
  ctx: PyVisitContext,
  callNode: SyntaxNode,
  httpMethod: string,
  urlLiteral: string | null,
  egressConfidence: HttpEgressConfidence,
): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = callNode.startPosition.row + 1;
  const ext = urlLiteral ? detectExternalUrl(urlLiteral) : { isExternal: false, host: null };
  const snippet = callNode.text;

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
    framework: 'aiohttp',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: sourceLine,
      lineEnd: callNode.endPosition.row + 1,
      snippet: snippet.length <= 500 ? snippet : snippet.slice(0, 499) + '…',
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

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === 'string' || c.type === 'concatenated_string') {
      return stripPythonString(c.text);
    }
  }
  return null;
}

function secondIdentifierArg(args: SyntaxNode): string | null {
  // Pull the SECOND positional arg as a bare identifier; aiohttp's
  // add_get(path, handler) and web.get(path, handler) both put the
  // handler reference there.
  let positionalCount = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    positionalCount++;
    if (positionalCount === 2 && c.type === 'identifier') return c.text;
  }
  return null;
}

function firstPositionalArg(args: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    return c;
  }
  return null;
}

function resolveUrlArg(arg: SyntaxNode | null): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (!arg) return { urlLiteral: null, egressConfidence: 'dynamic' };
  if (arg.type === 'string') {
    const lit = stripPythonString(arg.text);
    if (lit !== null) return { urlLiteral: lit, egressConfidence: 'exact' };
  }
  if (arg.type === 'concatenated_string') {
    let combined = '';
    for (let i = 0; i < arg.childCount; i++) {
      const c = arg.child(i);
      if (!c) continue;
      if (c.type !== 'string') return { urlLiteral: null, egressConfidence: 'dynamic' };
      const lit = stripPythonString(c.text);
      if (lit === null) return { urlLiteral: null, egressConfidence: 'dynamic' };
      combined += lit;
    }
    if (combined.length > 0) return { urlLiteral: combined, egressConfidence: 'exact' };
  }
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

function stripPythonString(text: string): string | null {
  let s = text;
  if (/^[rRbBuU]*[fF]/.test(s)) return null;
  s = s.replace(/^[rRbBuU]+/, '');
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return null;
}

function extractMethod(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'function_definition') return node;
  if (node.type === 'decorated_definition') {
    const def = node.childForFieldName('definition');
    if (def && def.type === 'function_definition') return def;
  }
  return null;
}

function lastDottedSegment(text: string): string {
  const idx = text.lastIndexOf('.');
  return idx >= 0 ? text.slice(idx + 1) : text;
}

function scanModuleImports(rootNode: SyntaxNode): FileFlags {
  let importsAiohttp = false;
  const check = (node: SyntaxNode): void => {
    if (node.type === 'import_statement') {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c) continue;
        const head = firstSeg(c);
        if (head === 'aiohttp') importsAiohttp = true;
      }
    } else if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name');
      if (mod && firstSeg(mod) === 'aiohttp') importsAiohttp = true;
    }
  };
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    check(c);
  }
  return { importsAiohttp };
}

function firstSeg(node: SyntaxNode): string | null {
  if (node.type === 'aliased_import') {
    const inner = node.childForFieldName('name') ?? node.child(0);
    if (inner) return firstSeg(inner);
    return null;
  }
  if (node.type === 'dotted_name') {
    const f = node.child(0);
    return f?.text ?? null;
  }
  if (node.type === 'identifier') return node.text;
  return null;
}
