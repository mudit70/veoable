import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@veoable/schema';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@veoable/lang-rust';

/**
 * Poem framework visitor.
 *
 * Each `.at("/path", <method-router>)` call emits one APIEndpoint
 * per HTTP method visible in the second arg. The method-router can
 * be any of:
 *
 *   get(handler)
 *   post(handler)
 *   get(list).post(create).delete(remove)   — chained
 *
 * `.nest("/p", router)` prefixes are NOT yet composed across `let`
 * bindings (out of scope for v1; same limitation as warp).
 */

const HTTP_METHODS: ReadonlyMap<string, string> = new Map([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['delete', 'DELETE'],
  ['patch', 'PATCH'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
]);

export function createPoemVisitor(): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = hasCrateImport(root, 'poem');
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'field_expression') return;
      const field = fn.childForFieldName('field');
      if (!field || field.text !== 'at') return;

      const args = node.childForFieldName('arguments');
      if (!args) return;

      const pathArg = firstStringArg(args);
      if (pathArg === null) return;

      const methodRouter = secondArg(args);
      if (!methodRouter) return;

      const methods = extractMethodsFromRouter(methodRouter);
      if (methods.length === 0) return;

      for (const m of methods) {
        emitEndpoint(ctx, node, m, pathArg);
      }
    },
  };
}

function emitEndpoint(
  ctx: RustVisitContext,
  node: SyntaxNode,
  httpMethod: string,
  routePattern: string,
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
    framework: 'poem',
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

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type !== 'string_literal' && c.type !== 'raw_string_literal') return null;
    return stripRustString(c.text);
  }
  return null;
}

function secondArg(args: SyntaxNode): SyntaxNode | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === 1) return c;
    seen++;
  }
  return null;
}

/**
 * Walk the method-router arg (`get(h).post(h).delete(h)`) and collect
 * every HTTP-method identifier we recognize. Both the head identifier
 * (the first `get(...)` / `post(...)`) and any chained method-name
 * fields count.
 */
function extractMethodsFromRouter(node: SyntaxNode): string[] {
  const found = new Set<string>();
  function walk(n: SyntaxNode): void {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) {
        if (fn.type === 'identifier') {
          const m = HTTP_METHODS.get(fn.text);
          if (m) found.add(m);
        } else if (fn.type === 'field_expression') {
          const field = fn.childForFieldName('field');
          if (field) {
            const m = HTTP_METHODS.get(field.text);
            if (m) found.add(m);
          }
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  }
  walk(node);
  return Array.from(found);
}

function stripRustString(text: string): string {
  if (text.startsWith('b') || text.startsWith('B')) text = text.slice(1);
  if (text.startsWith('r')) {
    const hashes = /^r(#*)"/.exec(text);
    if (hashes) {
      const h = hashes[1].length;
      const closer = '"' + '#'.repeat(h);
      const start = 1 + h + 1;
      if (text.endsWith(closer)) return text.slice(start, text.length - closer.length);
    }
    return text;
  }
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}
