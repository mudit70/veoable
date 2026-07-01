import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@adorable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';

/**
 * WebSockets (Go) visitor.
 *
 * Detection paths:
 *
 * 1. **Server upgrade** — call_expression on `selector_expression`
 *    where the trailing method is `Upgrade` (gorilla) or `Accept`
 *    (nhooyr / coder). Each emits an APIEndpoint, routePattern='ws:/'.
 *
 * 2. **Client dial** — call_expression with field `Dial` where the
 *    receiver text matches a websocket dialer:
 *    - gorilla: `websocket.DefaultDialer.Dial(url, ...)`
 *    - nhooyr: `websocket.Dial(ctx, url, ...)`
 *    First string-literal arg becomes the urlLiteral.
 *
 * Per-file gate: file must `import` one of the websocket modules.
 */

const SERVER_VERBS: ReadonlySet<string> = new Set(['Upgrade', 'Accept']);

export function createWsGoVisitor(): GoFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = scanFileImports(root);
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'selector_expression') return;
      const field = fn.childForFieldName('field');
      if (!field) return;
      const methodName = field.text;

      if (SERVER_VERBS.has(methodName)) {
        emitEndpoint(ctx, node);
        return;
      }

      if (methodName === 'Dial') {
        const args = node.childForFieldName('arguments');
        if (!args) return;
        const url = firstUrlLikeStringArg(args);
        if (url !== null) emitCaller(ctx, node, url);
        return;
      }
    },
  };
}

function firstUrlLikeStringArg(args: SyntaxNode): string | null {
  // Walk positional args left-to-right looking for a string literal
  // whose value starts with `ws://`, `wss://`, `http://`, or
  // `https://` (the latter two because the URL can be a relative or
  // protocol-flexible literal). gorilla's `Dial` takes the URL as
  // its FIRST positional arg; nhooyr's takes ctx first, then URL —
  // so we scan rather than hard-code position 0.
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type !== 'interpreted_string_literal' && c.type !== 'raw_string_literal') continue;
    const s = stripGoString(c.text);
    if (s.startsWith('ws://') || s.startsWith('wss://')) return s;
  }
  return null;
}

function stripGoString(text: string): string {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function emitEndpoint(ctx: GoVisitContext, node: SyntaxNode): void {
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
    framework: 'ws-go',
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

function emitCaller(ctx: GoVisitContext, node: SyntaxNode, url: string): void {
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
    framework: 'ws-go',
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

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_declaration') continue;
    const t = c.text;
    if (
      t.includes('github.com/gorilla/websocket')
      || t.includes('nhooyr.io/websocket')
      || t.includes('github.com/coder/websocket')
    ) {
      return true;
    }
  }
  return false;
}
