import { Node, type Expression } from 'ts-morph';
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@adorable/schema';
import {
  buildEvidence,
  readStringLiteral,
  type TsFrameworkVisitor,
  type TsVisitContext,
} from '@adorable/lang-ts';

/**
 * amqplib visitor.
 *
 * Detection paths:
 *
 *   Producer:
 *     channel.publish(exchange, routingKey, content)
 *       → urlLiteral=`amqp:<exchange>/<routingKey>`
 *     channel.sendToQueue(queue, content)
 *       → urlLiteral=`amqp:/<queue>` (exchange is the default)
 *
 *   Consumer:
 *     channel.consume(queue, handler)
 *       → routePattern=`amqp:/<queue>`
 *     channel.bindQueue(queue, exchange, pattern)
 *       (declaration, not data flow) — out of scope for v1.
 *
 * Per-file gate: file must `import` from `'amqplib'` or
 * `'amqplib/callback_api'`.
 */
export function createAmqplibVisitor(): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();

  const fileImports = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === 'amqplib' || spec.startsWith('amqplib/');
    });
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!fileImports(node, ctx.sourceFile.filePath)) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const methodName = callee.getNameNode().getText();

      const args = node.getArguments();

      // ── publish(exchange, routingKey, content) ──
      if (methodName === 'publish') {
        if (!ctx.enclosingFunction) return;
        const exchange = readStringLiteral(args[0] as Expression);
        const routingKey = readStringLiteral(args[1] as Expression);
        // Require both to be literals — partial-literal pairs end up
        // in the same bucket and pollute the graph.
        if (exchange === null || routingKey === null) return;
        emitCaller(ctx, node, exchange, routingKey);
        return;
      }

      // ── sendToQueue(queue, content) ──
      if (methodName === 'sendToQueue') {
        if (!ctx.enclosingFunction) return;
        const queue = readStringLiteral(args[0] as Expression);
        if (queue === null) return;
        emitCaller(ctx, node, '', queue);
        return;
      }

      // ── consume(queue, handler) ──
      if (methodName === 'consume') {
        const queue = readStringLiteral(args[0] as Expression);
        if (queue === null) return;
        emitEndpoint(ctx, node, '', queue);
        return;
      }
    },
  };
}

function rabbitUrl(exchange: string, routingKey: string): string {
  return `amqp:${exchange}/${routingKey}`;
}

function emitEndpoint(ctx: TsVisitContext, node: Node, exchange: string, routingKey: string): void {
  const routePattern = rabbitUrl(exchange, routingKey);
  const evidence = buildEvidence(node, ctx.sourceFile.filePath);
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'JOB',
      routePattern,
      filePath: evidence.filePath,
      lineStart: evidence.lineStart,
    }),
    httpMethod: 'JOB',
    routePattern,
    handlerFunctionId: ctx.enclosingFunction?.id ?? null,
    framework: 'amqplib',
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(endpoint);
}

function emitCaller(ctx: TsVisitContext, node: Node, exchange: string, routingKey: string): void {
  if (!ctx.enclosingFunction) return;
  const urlLiteral = rabbitUrl(exchange, routingKey);
  const evidence = buildEvidence(node, ctx.sourceFile.filePath);
  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine: evidence.lineStart,
      urlLiteral,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine: evidence.lineStart,
    httpMethod: 'JOB',
    urlLiteral,
    egressConfidence: 'exact',
    framework: 'amqplib',
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
