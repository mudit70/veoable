import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

/**
 * websockets (Python) visitor.
 *
 * Detects:
 *
 *   websockets.serve(handler, host, port, ...)
 *     → APIEndpoint with routePattern='ws:/', handlerFunctionId
 *       resolved from the first positional arg (if it's an
 *       identifier matching a function definition in this file).
 *
 *   websockets.connect("ws://...")
 *     → ClientSideAPICaller with urlLiteral=<ws-url>.
 *
 * Per-file gate: file must `import websockets` (or
 * `from websockets import ...`).
 */
export function createWsPyVisitor(): PyFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = scanFileImports(root);
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;
      handleCall(ctx, node);
    },
  };
}

function handleCall(ctx: PyVisitContext, node: SyntaxNode): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;

  // websockets.serve / websockets.connect
  if (fn.type === 'attribute') {
    const obj = fn.childForFieldName('object');
    const attr = fn.childForFieldName('attribute');
    if (!obj || !attr) return;
    if (obj.text !== 'websockets') return;
    if (attr.text === 'serve') {
      emitEndpoint(ctx, node);
      return;
    }
    if (attr.text === 'connect') {
      const args = node.childForFieldName('arguments');
      const url = args ? firstStringArg(args) : null;
      if (url !== null) emitCaller(ctx, node, url);
      return;
    }
  }

  // Bare `serve(...)` / `connect(...)` when `from websockets import serve, connect`.
  if (fn.type === 'identifier') {
    if (fn.text === 'serve') {
      emitEndpoint(ctx, node);
      return;
    }
    if (fn.text === 'connect') {
      const args = node.childForFieldName('arguments');
      const url = args ? firstStringArg(args) : null;
      if (url !== null) emitCaller(ctx, node, url);
      return;
    }
  }
}

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === 'string' || c.type === 'concatenated_string') {
      return stripPythonString(c.text);
    }
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    return null;
  }
  return null;
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

function emitEndpoint(ctx: PyVisitContext, evidenceNode: SyntaxNode): void {
  const routePattern = `ws:/`;
  const evidenceLine = evidenceNode.startPosition.row + 1;
  const handlerFunctionId = ctx.enclosingFunction?.id ?? null;

  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'WS',
      routePattern,
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
    }),
    httpMethod: 'WS',
    routePattern,
    handlerFunctionId,
    framework: 'ws-py',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
      lineEnd: evidenceNode.endPosition.row + 1,
      snippet: evidenceNode.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(endpoint);
}

function emitCaller(ctx: PyVisitContext, callNode: SyntaxNode, url: string): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = callNode.startPosition.row + 1;

  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      urlLiteral: url,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    httpMethod: 'WS',
    urlLiteral: url,
    egressConfidence: 'exact',
    framework: 'ws-py',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: sourceLine,
      lineEnd: callNode.endPosition.row + 1,
      snippet: callNode.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(caller);
  ctx.emitEdge({
    edgeType: 'MAKES_REQUEST',
    from: ctx.enclosingFunction.id,
    to: caller.id,
  });
}

function scanFileImports(root: SyntaxNode): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (!c) continue;
    if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
    if (/\bwebsockets\b/.test(c.text)) return true;
  }
  return false;
}
