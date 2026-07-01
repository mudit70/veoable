import { Node, type Expression, type ObjectLiteralExpression, type PropertyAssignment } from 'ts-morph';
import {
  idFor,
  type APIEndpoint,
  type ClientSideAPICaller,
} from '@veoable/schema';
import {
  buildEvidence,
  readStringLiteral,
  type TsFrameworkVisitor,
  type TsVisitContext,
} from '@veoable/lang-ts';

/**
 * ws + socket.io visitor.
 *
 * Server-side detection:
 *
 * 1. `new WebSocketServer({ port, path })` (ws) → APIEndpoint
 *    `routePattern='ws:<path>'`. If no `path` arg, default `'ws:/'`.
 *
 * 2. `new Server(...)` from socket.io → APIEndpoint
 *    `routePattern='ws:/'` (socket.io attaches to the root).
 *
 * 3. `<recv>.on('connection', handler)` → APIEndpoint
 *    `routePattern='ws:connection'`. This catches both
 *    `wss.on('connection', ...)` and `io.on('connection', ...)`.
 *
 * 4. `<recv>.on('event-name', handler)` inside the connection
 *    handler — out of scope for v1 (would need nested-scope
 *    tracking). Documented as a known gap.
 *
 * Client-side detection:
 *
 * 5. `new WebSocket('ws://...')` → ClientSideAPICaller with
 *    `urlLiteral=<ws-url>`.
 *
 * Per-file gate: file must import from `'ws'` or `'socket.io'`.
 */

const SERVER_CTORS: ReadonlySet<string> = new Set([
  'WebSocketServer',
  'Server', // socket.io's `Server`
]);

export function createWsTsVisitor(): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();

  const fileImports = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === 'ws' || spec.startsWith('ws/')
        || spec === 'socket.io' || spec.startsWith('socket.io/');
    });
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!fileImports(node, ctx.sourceFile.filePath)) return;

      // ── new WebSocketServer(...) | new Server(...) | new WebSocket('ws://...') ──
      if (Node.isNewExpression(node)) {
        const callee = node.getExpression();
        let calleeName: string | null = null;
        if (Node.isIdentifier(callee)) calleeName = callee.getText();
        else if (Node.isPropertyAccessExpression(callee)) calleeName = callee.getNameNode().getText();

        if (calleeName && SERVER_CTORS.has(calleeName)) {
          const opts = firstObjectLiteralArg(node.getArguments());
          const path = opts ? readPropertyStringLiteral(opts, 'path') : null;
          emitServerEndpoint(ctx, node, path);
          return;
        }
        if (calleeName === 'WebSocket') {
          const urlArg = node.getArguments()[0] as Expression | undefined;
          const url = urlArg ? readStringLiteral(urlArg) : null;
          if (url) emitClientCaller(ctx, node, url);
          return;
        }
        return;
      }

      // ── <recv>.on('connection', handler) — generic WS handshake ──
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) return;
        if (callee.getNameNode().getText() !== 'on') return;

        const args = node.getArguments();
        if (args.length < 2) return;
        const eventName = readStringLiteral(args[0] as Expression);
        if (eventName !== 'connection') return;

        // Emit one endpoint for the connection handshake. The
        // per-event `socket.on('chat:message', ...)` inside the
        // closure is out of scope for v1.
        emitServerEndpoint(ctx, node, '/');
      }
    },
  };
}

function firstObjectLiteralArg(args: readonly Node[]): ObjectLiteralExpression | null {
  const first = args[0];
  if (!first) return null;
  if (Node.isObjectLiteralExpression(first)) return first;
  return null;
}

function readPropertyStringLiteral(obj: ObjectLiteralExpression, name: string): string | null {
  const prop = obj.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init) return null;
  return readStringLiteral(init);
}

function emitServerEndpoint(ctx: TsVisitContext, node: Node, pathLiteral: string | null): void {
  const routePattern = `ws:${pathLiteral ?? '/'}`;
  const evidence = buildEvidence(node, ctx.sourceFile.filePath);
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'WS',
      routePattern,
      filePath: evidence.filePath,
      lineStart: evidence.lineStart,
    }),
    httpMethod: 'WS',
    routePattern,
    handlerFunctionId: ctx.enclosingFunction?.id ?? null,
    framework: 'ws-ts',
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(endpoint);
}

function emitClientCaller(ctx: TsVisitContext, node: Node, url: string): void {
  if (!ctx.enclosingFunction) return;
  const evidence = buildEvidence(node, ctx.sourceFile.filePath);
  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine: evidence.lineStart,
      urlLiteral: url,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine: evidence.lineStart,
    httpMethod: 'WS',
    urlLiteral: url,
    egressConfidence: 'exact',
    framework: 'ws-ts',
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(caller);
  ctx.emitEdge({
    edgeType: 'MAKES_REQUEST',
    from: ctx.enclosingFunction.id,
    to: caller.id,
  });
}
