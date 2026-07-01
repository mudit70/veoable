import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@adorable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';

/**
 * Echo framework visitor.
 *
 * Mirrors framework-gin's emit shape and group-composition logic.
 * Detected shapes:
 *
 *   e.GET / e.POST / e.PUT / e.DELETE / e.PATCH / e.HEAD / e.OPTIONS
 *   e.Any("/path", handler)                            → ALL
 *   e.Match([]string{"GET","POST"}, "/path", handler)
 *
 *   g := e.Group("/api"); g.GET("/users", h)           →  /api/users
 *
 * Only matches files that import `labstack/echo`.
 */

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE',
]);

export function createEchoVisitor(): GoFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();
  const prefixesByFile = new Map<string, Map<string, string>>();

  return {
    language: 'go',
    onNode(ctx, node) {
      const fileId = ctx.sourceFile.id;

      if (node.type === 'source_file') {
        if (!prefixesByFile.has(fileId)) {
          prefixesByFile.set(fileId, scanFileForGroupPrefixes(node));
        }
        return;
      }

      if (node.type !== 'call_expression') return;
      if (!fileImportsEcho(node, ctx.sourceFile.filePath, fileImportCache)) return;

      const fnNode = node.childForFieldName('function');
      if (!fnNode || fnNode.type !== 'selector_expression') return;
      const field = fnNode.childForFieldName('field');
      if (!field) return;
      const methodName = field.text;

      const operand = fnNode.childForFieldName('operand');
      if (!operand) return;
      if (operand.text === 'echo') return;

      const args = node.childForFieldName('arguments');
      if (!args) return;

      const receiverName = operand.type === 'identifier' ? operand.text : null;
      const prefix = receiverName
        ? (prefixesByFile.get(fileId)?.get(receiverName) ?? '')
        : '';

      if (HTTP_METHODS.has(methodName)) {
        const pathArg = findFirstStringArg(args);
        if (pathArg === null) return;
        emitEndpoint(ctx, node, methodName, joinPaths(prefix, pathArg));
        return;
      }

      if (methodName === 'Any') {
        const pathArg = findFirstStringArg(args);
        if (pathArg === null) return;
        emitEndpoint(ctx, node, 'ALL', joinPaths(prefix, pathArg));
        return;
      }

      // e.Match([]string{"GET","POST"}, "/path", handler)
      if (methodName === 'Match') {
        const methods = extractStringsFromSliceLiteral(args);
        const pathArg = firstStringArgAfterIndex(args, 1);
        if (pathArg === null || methods.length === 0) return;
        const routePattern = joinPaths(prefix, pathArg);
        for (const m of methods) {
          emitEndpoint(ctx, node, m.toUpperCase(), routePattern);
        }
        return;
      }
    },
  };

  function emitEndpoint(ctx: GoVisitContext, node: SyntaxNode, httpMethod: string, routePattern: string): void {
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
      framework: 'echo',
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
}

function fileImportsEcho(
  node: SyntaxNode,
  filePath: string,
  cache: Map<string, boolean>,
): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const root = node.tree.rootNode;
  let has = false;
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i)!;
    if (c.type === 'import_declaration' && c.text.includes('labstack/echo')) {
      has = true;
      break;
    }
  }
  cache.set(filePath, has);
  return has;
}

function findFirstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i)!;
    if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
      return c.text.slice(1, -1);
    }
  }
  return null;
}

function firstStringArgAfterIndex(args: SyntaxNode, skip: number): string | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i)!;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen < skip) {
      seen++;
      continue;
    }
    if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
      return c.text.slice(1, -1);
    }
    seen++;
  }
  return null;
}

/**
 * Extract string literals from the first `[]string{...}` slice composite
 * literal in args. Used for `e.Match([]string{"GET","POST"}, ...)`.
 */
function extractStringsFromSliceLiteral(args: SyntaxNode): string[] {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i)!;
    if (c.type !== 'composite_literal') continue;
    const out: string[] = [];
    walkStrings(c, out);
    return out;
  }
  return [];
}

function walkStrings(node: SyntaxNode, out: string[]): void {
  if (node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal') {
    out.push(node.text.slice(1, -1));
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    walkStrings(node.child(i)!, out);
  }
}

// ── Group prefix scanning (mirrors gin's logic) ─────────────────────

function scanFileForGroupPrefixes(rootNode: SyntaxNode): Map<string, string> {
  const raw = new Map<string, { parent: string | null; segment: string }>();
  function walk(node: SyntaxNode): void {
    if (node.type === 'short_var_declaration' || node.type === 'var_spec') {
      collectFromVarDecl(node, raw);
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(rootNode);

  const composed = new Map<string, string>();
  for (const [name] of raw) {
    composed.set(name, resolvePrefix(name, raw, new Set<string>()));
  }
  return composed;
}

function collectFromVarDecl(
  node: SyntaxNode,
  out: Map<string, { parent: string | null; segment: string }>,
): void {
  const left = node.childForFieldName('left') ?? node.childForFieldName('name');
  const right = node.childForFieldName('right') ?? node.childForFieldName('value');
  if (!left || !right) return;

  const names: string[] = [];
  if (left.type === 'identifier') names.push(left.text);
  else for (let i = 0; i < left.childCount; i++) {
    const c = left.child(i)!;
    if (c.type === 'identifier') names.push(c.text);
  }

  const exprs: SyntaxNode[] = [];
  if (right.type === 'call_expression') exprs.push(right);
  else for (let i = 0; i < right.childCount; i++) {
    const c = right.child(i)!;
    if (c.type === 'call_expression') exprs.push(c);
  }

  for (let i = 0; i < names.length && i < exprs.length; i++) {
    const r = parseGroupCall(exprs[i]);
    if (r) out.set(names[i], r);
  }
}

function parseGroupCall(call: SyntaxNode): { parent: string | null; segment: string } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'selector_expression') return null;
  const field = fn.childForFieldName('field');
  if (!field || field.text !== 'Group') return null;
  const operand = fn.childForFieldName('operand');
  const parent = operand && operand.type === 'identifier' ? operand.text : null;
  const args = call.childForFieldName('arguments');
  if (!args) return null;
  const segment = findFirstStringArg(args);
  if (segment === null) return null;
  return { parent, segment };
}

function resolvePrefix(
  name: string,
  raw: Map<string, { parent: string | null; segment: string }>,
  visited: Set<string>,
): string {
  if (visited.has(name)) return '';
  visited.add(name);
  const entry = raw.get(name);
  if (!entry) return '';
  const parentPrefix = entry.parent ? resolvePrefix(entry.parent, raw, visited) : '';
  return joinPaths(parentPrefix, entry.segment);
}

function joinPaths(prefix: string, suffix: string): string {
  if (prefix === '') return suffix;
  if (suffix === '') return prefix;
  const p = prefix.replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : '/' + suffix;
  return p + s;
}
