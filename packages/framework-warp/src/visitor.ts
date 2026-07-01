import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@veoable/schema';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@veoable/lang-rust';

/**
 * Warp framework visitor.
 *
 * Match every `warp::path!(...)` macro invocation and emit one
 * `APIEndpoint`. Path segments come from the macro args:
 *   - string literal  → segment as-is
 *   - bare identifier (type)  → `:param`
 *   - `..` rest pattern  → `*`
 *
 * Method extraction: scan the enclosing `let` statement (or the
 * smallest let_declaration ancestor of the macro) for
 * `warp::get()` / `warp::post()` / etc. occurrences. If none, emit
 * `ALL`.
 *
 * Conservative misses (acceptable for v1):
 * - Routes built across multiple `let` bindings (composition routes)
 *   may attribute the wrong method.
 * - `warp::path("a").and(warp::path("b"))` builder chains (no `!`)
 *   are NOT covered yet — only the `path!` macro form is. Documented
 *   in the docstring.
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

export function createWarpVisitor(): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = hasCrateImport(root, 'warp');
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'macro_invocation') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      // Verify the macro is `warp::path` (i.e. macro identifier is
      // `path` with scope `warp`).
      const macroName = node.childForFieldName('macro');
      if (!macroName) return;
      const macroText = macroName.text;
      if (macroText !== 'warp::path' && macroText !== 'path') return;
      // If bare `path!`, require a `use warp::path` import. Otherwise
      // we'd match too aggressively. For v1 require the qualified form.
      if (macroText === 'path') return;

      const routePattern = extractPathFromMacroArgs(node);
      if (routePattern === null) return;

      const methods = inferMethodsFromEnclosing(node);
      const evidenceLine = node.startPosition.row + 1;
      for (const m of methods) {
        emitEndpoint(ctx, node, m, routePattern, evidenceLine);
      }
    },
  };
}

function emitEndpoint(
  ctx: RustVisitContext,
  node: SyntaxNode,
  httpMethod: string,
  routePattern: string,
  evidenceLine: number,
): void {
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
    handlerFunctionId: null,
    framework: 'warp',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
      lineEnd: node.endPosition.row + 1,
      snippet: node.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(endpoint);
}

/**
 * Extract a route pattern from a `warp::path!(...)` macro's args.
 * Parses the token list textually since macro internals aren't
 * proper syntax nodes.
 */
function extractPathFromMacroArgs(macroNode: SyntaxNode): string | null {
  // The macro's last child is the parenthesized/braced token tree.
  // Find it and read its text.
  let tokenTree: SyntaxNode | null = null;
  for (let i = macroNode.childCount - 1; i >= 0; i--) {
    const c = macroNode.child(i);
    if (!c) continue;
    if (c.type === 'token_tree' || c.text.startsWith('(') || c.text.startsWith('[') || c.text.startsWith('{')) {
      tokenTree = c;
      break;
    }
  }
  if (!tokenTree) return null;
  const raw = tokenTree.text;
  // Strip the outer brackets.
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return '';

  // Split on `/` at the top level (no nested brackets in path
  // patterns, so a simple split works).
  const parts = inner.split('/').map((p) => p.trim()).filter((p) => p.length > 0);
  const segments: string[] = [];
  for (const p of parts) {
    if (p === '..') {
      segments.push('*');
      continue;
    }
    // String literal: "literal" or r"raw" or b"bytes" — extract.
    const m = /^"([^"\\]*(?:\\.[^"\\]*)*)"$/.exec(p);
    if (m) {
      segments.push(m[1]);
      continue;
    }
    // Otherwise treat as a parameter (type identifier).
    const id = /^[A-Za-z_][\w]*$/.exec(p);
    if (id) {
      segments.push(`:${id[0]}`);
      continue;
    }
    // Unknown — fall back to literal text.
    segments.push(p);
  }
  return '/' + segments.join('/');
}

/**
 * Walk up from the macro to its enclosing `let_declaration` (or
 * `expression_statement` / `let_chain`) and scan that text for
 * `warp::get()` etc.
 */
function inferMethodsFromEnclosing(node: SyntaxNode): string[] {
  let scope: SyntaxNode | null = node;
  while (scope) {
    const t = scope.type;
    if (t === 'let_declaration' || t === 'expression_statement' || t === 'function_item') {
      break;
    }
    scope = scope.parent;
  }
  if (!scope) return ['ALL'];

  const text = scope.text;
  const found = new Set<string>();
  for (const [name, canonical] of HTTP_METHODS) {
    const re = new RegExp(`\\bwarp\\s*::\\s*${name}\\s*\\(\\s*\\)`);
    if (re.test(text)) found.add(canonical);
  }
  if (found.size === 0) return ['ALL'];
  return Array.from(found);
}
