import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@veoable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@veoable/lang-go';

/**
 * Fiber framework visitor.
 *
 * Detected:
 *   app.Get("/path", h)               → GET
 *   app.Post / Put / Delete / Patch / Head / Options / Connect / Trace
 *   app.All("/path", h)               → ALL
 *   app.Add("METHOD", "/path", h)
 *   api := app.Group("/api"); api.Get(...)
 *
 * Note: Fiber's verbs are Title-Case (Get, Post) not all-caps; the
 * map keys mirror that, and the emitted httpMethod is uppercase to
 * match the canonical convention across siblings.
 */

const HTTP_METHODS_TITLECASE: ReadonlyMap<string, string> = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Delete', 'DELETE'],
  ['Patch', 'PATCH'],
  ['Head', 'HEAD'],
  ['Options', 'OPTIONS'],
  ['Connect', 'CONNECT'],
  ['Trace', 'TRACE'],
]);

export function createFiberVisitor(): GoFrameworkVisitor {
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
      if (!fileImportsFiber(node, ctx.sourceFile.filePath, fileImportCache)) return;

      const fnNode = node.childForFieldName('function');
      if (!fnNode || fnNode.type !== 'selector_expression') return;
      const field = fnNode.childForFieldName('field');
      if (!field) return;
      const methodName = field.text;

      const operand = fnNode.childForFieldName('operand');
      if (!operand) return;
      if (operand.text === 'fiber') return;

      const args = node.childForFieldName('arguments');
      if (!args) return;

      const receiverName = operand.type === 'identifier' ? operand.text : null;
      const prefix = receiverName
        ? (prefixesByFile.get(fileId)?.get(receiverName) ?? '')
        : '';

      const canonical = HTTP_METHODS_TITLECASE.get(methodName);
      if (canonical) {
        const pathArg = findFirstStringArg(args);
        if (pathArg === null) return;
        emitEndpoint(ctx, node, canonical, joinPaths(prefix, pathArg));
        return;
      }

      if (methodName === 'All') {
        const pathArg = findFirstStringArg(args);
        if (pathArg === null) return;
        emitEndpoint(ctx, node, 'ALL', joinPaths(prefix, pathArg));
        return;
      }

      if (methodName === 'Add') {
        const argValues = extractStringArgs(args, 2);
        if (argValues.length < 2) return;
        emitEndpoint(ctx, node, argValues[0].toUpperCase(), joinPaths(prefix, argValues[1]));
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
      framework: 'fiber',
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

function fileImportsFiber(
  node: SyntaxNode,
  filePath: string,
  cache: Map<string, boolean>,
): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const root = node.tree.rootNode;
  let has = false;
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i)!;
    if (c.type === 'import_declaration' && c.text.includes('gofiber/fiber')) {
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

function extractStringArgs(args: SyntaxNode, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.childCount && out.length < count; i++) {
    const c = args.child(i)!;
    if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
      out.push(c.text.slice(1, -1));
    }
  }
  return out;
}

// ── Group prefix scanning (same shape as gin/echo) ─────────────────

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
  for (const [name] of raw) composed.set(name, resolvePrefix(name, raw, new Set<string>()));
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
