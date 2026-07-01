import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@adorable/schema';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@adorable/lang-rust';

/**
 * tokio-tungstenite / tungstenite visitor.
 *
 * Detection:
 *
 *   let ws_stream = accept_async(stream).await?;
 *     → APIEndpoint, routePattern='ws:/'.
 *
 *   let (ws, _) = connect_async("ws://api/feed").await?;
 *     → ClientSideAPICaller, urlLiteral=<url>.
 *
 * Per-file gate: `use tokio_tungstenite` or `use tungstenite`.
 */

const SERVER_FNS: ReadonlySet<string> = new Set(['accept_async', 'accept']);
const CLIENT_FNS: ReadonlySet<string> = new Set(['connect_async', 'connect']);

export function createWsRsVisitor(): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = hasCrateImport(root, 'tokio_tungstenite') || hasCrateImport(root, 'tungstenite');
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn) return;

      // Bare-call form: accept_async(...) / connect_async(...)
      if (fn.type === 'identifier') {
        if (SERVER_FNS.has(fn.text)) {
          emitEndpoint(ctx, node);
          return;
        }
        if (CLIENT_FNS.has(fn.text)) {
          const args = node.childForFieldName('arguments');
          const url = args ? firstUrlLikeStringArg(args) : null;
          if (url !== null) emitCaller(ctx, node, url);
          return;
        }
        return;
      }

      // Scoped form: tokio_tungstenite::accept_async(...) /
      //   tokio_tungstenite::connect_async(...)
      if (fn.type === 'scoped_identifier') {
        const name = fn.childForFieldName('name');
        if (!name) return;
        if (SERVER_FNS.has(name.text)) {
          emitEndpoint(ctx, node);
          return;
        }
        if (CLIENT_FNS.has(name.text)) {
          const args = node.childForFieldName('arguments');
          const url = args ? firstUrlLikeStringArg(args) : null;
          if (url !== null) emitCaller(ctx, node, url);
          return;
        }
      }
    },
  };
}

function firstUrlLikeStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type !== 'string_literal' && c.type !== 'raw_string_literal') continue;
    const s = stripRustString(c.text);
    if (s === null) continue;
    if (s.startsWith('ws://') || s.startsWith('wss://')) return s;
  }
  return null;
}

function stripRustString(text: string): string | null {
  let s = text;
  if (s.startsWith('b') || s.startsWith('B')) s = s.slice(1);
  if (s.startsWith('r')) {
    const hashes = /^r(#*)"/.exec(s);
    if (hashes) {
      const h = hashes[1].length;
      const closer = '"' + '#'.repeat(h);
      const start = 1 + h + 1;
      if (s.endsWith(closer)) return s.slice(start, s.length - closer.length);
    }
    return null;
  }
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return null;
}

function emitEndpoint(ctx: RustVisitContext, node: SyntaxNode): void {
  const routePattern = `ws:/`;
  const evidenceLine = node.startPosition.row + 1;
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
    framework: 'ws-rs',
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

function emitCaller(ctx: RustVisitContext, node: SyntaxNode, url: string): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = node.startPosition.row + 1;

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
    framework: 'ws-rs',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: sourceLine,
      lineEnd: node.endPosition.row + 1,
      snippet: node.text.slice(0, 200),
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
