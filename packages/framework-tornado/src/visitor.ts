import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

/**
 * Tornado visitor.
 *
 * Tornado's canonical shape:
 *
 *   class UserHandler(tornado.web.RequestHandler):
 *       async def get(self): ...
 *       async def post(self): ...
 *
 *   app = tornado.web.Application([
 *       (r'/users', UserHandler),
 *       (r'/users/(\d+)', UserDetailHandler),
 *   ])
 *
 * Two-pass per file:
 *   1. Scan module-root for `Application([...])` calls and build a
 *      map `<HandlerClass> → URL`.
 *   2. For each `class_definition` inheriting from
 *      `tornado.web.RequestHandler` (or bare `RequestHandler`), emit
 *      one APIEndpoint per HTTP-verb method, using the URL from
 *      step 1 (falling back to `/handler/<ClassName>` synthetic).
 *
 * Conservative v1:
 *   - Only `Application([...])` tuple form. The
 *     `web.URLSpec(URL, Handler)` constructor form is detected too.
 *   - URL params (`(\d+)`) pass through unchanged. Future slice can
 *     normalize Tornado regex groups to `:param` style.
 *   - Class-based handlers only. Tornado also allows `app.add_handlers
 *     ('host', [(URL, Handler)])` and `web.Application(routes,
 *     handlers=...)` shapes — those go through the same Application
 *     scanner.
 */

const HTTP_VERB_METHODS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'head', 'options',
]);

export function createTornadoVisitor(): PyFrameworkVisitor {
  // Per-file map: handlerClassName → list of routeURLs. A single
  // handler can register at multiple URLs (the legacy-alias
  // `[(r'/v1/x', X), (r'/x', X)]` pattern), so keep the full list
  // and emit one APIEndpoint per (verb × URL).
  const routesByFile = new Map<string, Map<string, string[]>>();
  const getRoutes = (filePath: string, root: SyntaxNode): Map<string, string[]> => {
    let m = routesByFile.get(filePath);
    if (!m) {
      m = scanModuleForRoutes(root);
      routesByFile.set(filePath, m);
    }
    return m;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'class_definition') return;

      const supers = node.childForFieldName('superclasses');
      if (!supers) return;
      if (!hasRequestHandlerSuperclass(supers)) return;

      const classNameNode = node.childForFieldName('name');
      const className = classNameNode?.text;
      if (!className) return;

      const body = node.childForFieldName('body');
      if (!body) return;

      const routes = getRoutes(ctx.sourceFile.filePath, node.tree.rootNode);
      const registered = routes.get(className);
      const routePatterns = registered && registered.length > 0
        ? registered
        : [`/handler/${className}`];
      const isSynthetic = !registered || registered.length === 0;

      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (!child) continue;
        const methodNode = extractMethod(child);
        if (!methodNode) continue;

        const methodNameNode = methodNode.childForFieldName('name');
        const methodName = methodNameNode?.text;
        if (!methodName) continue;
        if (!HTTP_VERB_METHODS.has(methodName.toLowerCase())) continue;

        // Inheritance limitation: v1 only emits for methods defined
        // ON the class itself. Inherited verbs from a parent
        // RequestHandler subclass don't re-emit on the subclass —
        // same scope cut framework-grpcio takes.
        for (const routePattern of routePatterns) {
          emitEndpoint(
            ctx,
            methodNode,
            methodName.toUpperCase(),
            routePattern,
            `${className}.${methodName}`,
            methodNode.startPosition.row + 1,
            isSynthetic,
          );
        }
      }
    },
  };
}

function emitEndpoint(
  ctx: PyVisitContext,
  evidenceNode: SyntaxNode,
  httpMethod: string,
  routePattern: string,
  handlerName: string,
  handlerLine: number,
  isSynthetic: boolean,
): void {
  const handlerFunctionId = idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name: handlerName,
    sourceLine: handlerLine,
  });
  const evidenceLine = evidenceNode.startPosition.row + 1;

  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod,
      routePattern,
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
    }),
    httpMethod,
    routePattern,
    handlerFunctionId,
    framework: 'tornado',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
      lineEnd: evidenceNode.endPosition.row + 1,
      snippet: evidenceNode.text.slice(0, 200),
      // Synthetic /handler/<ClassName> URLs are heuristic.
      confidence: isSynthetic ? 'heuristic' : 'exact',
    },
  };
  ctx.emitNode(endpoint);
}

function hasRequestHandlerSuperclass(supers: SyntaxNode): boolean {
  for (let i = 0; i < supers.childCount; i++) {
    const c = supers.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    const text = lastDottedSegment(c.text);
    if (text === 'RequestHandler') return true;
  }
  return false;
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
  const i = text.lastIndexOf('.');
  return i >= 0 ? text.slice(i + 1) : text;
}

/**
 * Walk the module root and find every call to `Application` (or
 * `web.Application`/`tornado.web.Application`). The first positional
 * arg is a list of `(URL_PATTERN, HandlerClass)` tuples OR a list of
 * `URLSpec(URL_PATTERN, HandlerClass)` calls. Both shapes are
 * decoded into a map of `<HandlerClass-identifier> → URL`.
 */
function scanModuleForRoutes(rootNode: SyntaxNode): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'call') {
      const fn = n.childForFieldName('function');
      if (fn && isApplicationCallee(fn)) {
        const args = n.childForFieldName('arguments');
        if (args) {
          const list = firstListArg(args);
          if (list) decodeRoutesList(list, out);
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(rootNode);
  return out;
}

function isApplicationCallee(fn: SyntaxNode): boolean {
  if (fn.type === 'identifier') return fn.text === 'Application';
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    return attr?.text === 'Application';
  }
  return false;
}

function firstListArg(args: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    return c.type === 'list' ? c : null;
  }
  return null;
}

function decodeRoutesList(list: SyntaxNode, out: Map<string, string[]>): void {
  for (let i = 0; i < list.childCount; i++) {
    const item = list.child(i);
    if (!item) continue;
    // Tuple shape: (URL, HandlerClass) or (URL, HandlerClass, args).
    if (item.type === 'tuple') {
      decodeTuple(item, out);
      continue;
    }
    // URLSpec(URL, HandlerClass) / url(URL, HandlerClass) call shape.
    if (item.type === 'call') {
      const fn = item.childForFieldName('function');
      if (fn && isURLSpecCallee(fn)) {
        const args = item.childForFieldName('arguments');
        if (args) decodeURLSpecArgs(args, out);
      }
    }
  }
}

function recordRoute(out: Map<string, string[]>, handler: string, url: string): void {
  const existing = out.get(handler);
  if (existing) {
    if (!existing.includes(url)) existing.push(url);
  } else {
    out.set(handler, [url]);
  }
}

function decodeTuple(tuple: SyntaxNode, out: Map<string, string[]>): void {
  const positional: SyntaxNode[] = [];
  for (let i = 0; i < tuple.childCount; i++) {
    const c = tuple.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    positional.push(c);
  }
  if (positional.length < 2) return;
  const url = pythonStringValue(positional[0]);
  const handler = positional[1].type === 'identifier' ? positional[1].text : null;
  if (url && handler) recordRoute(out, handler, url);
}

function decodeURLSpecArgs(args: SyntaxNode, out: Map<string, string[]>): void {
  const positional: SyntaxNode[] = [];
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    positional.push(c);
  }
  if (positional.length < 2) return;
  const url = pythonStringValue(positional[0]);
  const handler = positional[1].type === 'identifier' ? positional[1].text : null;
  if (url && handler) recordRoute(out, handler, url);
}

function isURLSpecCallee(fn: SyntaxNode): boolean {
  if (fn.type === 'identifier') return fn.text === 'URLSpec' || fn.text === 'url';
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    return attr?.text === 'URLSpec' || attr?.text === 'url';
  }
  return false;
}

function pythonStringValue(node: SyntaxNode): string | null {
  if (node.type !== 'string' && node.type !== 'concatenated_string') return null;
  return stripPythonString(node.text);
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
