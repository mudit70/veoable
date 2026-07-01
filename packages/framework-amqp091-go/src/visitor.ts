import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@veoable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@veoable/lang-go';

/**
 * amqp091-go visitor.
 *
 * Producer:
 *   ch.PublishWithContext(ctx, "exchange", "routing.key", false, false,
 *                         amqp.Publishing{...})
 *   ch.Publish("exchange", "routing.key", false, false, amqp.Publishing{...})
 *
 *   PublishWithContext: index 1 = exchange, index 2 = routingKey.
 *   Publish:            index 0 = exchange, index 1 = routingKey.
 *
 * Consumer:
 *   ch.Consume("queue", "consumer-tag", autoAck, exclusive,
 *              noLocal, noWait, args)
 *   ch.ConsumeWithContext(ctx, "queue", ...)
 *
 * Per-file gate: amqp091 or streadway import.
 */
export function createAmqp091GoVisitor(): GoFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    let has = false;
    for (let i = 0; i < root.childCount; i++) {
      const c = root.child(i);
      if (!c) continue;
      if (c.type !== 'import_declaration') continue;
      const t = c.text;
      if (t.includes('rabbitmq/amqp091-go') || t.includes('streadway/amqp')) {
        has = true;
        break;
      }
    }
    importsByFile.set(filePath, has);
    return has;
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
      const args = node.childForFieldName('arguments');
      if (!args) return;

      const method = field.text;

      // Producers
      if (method === 'PublishWithContext') {
        if (!ctx.enclosingFunction) return;
        const exchange = stringArgAt(args, 1);
        const routingKey = stringArgAt(args, 2);
        if (exchange === null || routingKey === null) return;
        emitCaller(ctx, node, exchange, routingKey);
        return;
      }
      if (method === 'Publish') {
        if (!ctx.enclosingFunction) return;
        const exchange = stringArgAt(args, 0);
        const routingKey = stringArgAt(args, 1);
        if (exchange === null || routingKey === null) return;
        emitCaller(ctx, node, exchange, routingKey);
        return;
      }

      // Consumers
      if (method === 'Consume') {
        const queue = stringArgAt(args, 0);
        if (queue === null) return;
        emitEndpoint(ctx, node, '', queue);
        return;
      }
      if (method === 'ConsumeWithContext') {
        const queue = stringArgAt(args, 1);
        if (queue === null) return;
        emitEndpoint(ctx, node, '', queue);
        return;
      }
    },
  };
}

function stringArgAt(args: SyntaxNode, idx: number): string | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === idx) {
      if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
        return stripGoString(c.text);
      }
      return null;
    }
    seen++;
  }
  return null;
}

function stripGoString(text: string): string {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function emitEndpoint(ctx: GoVisitContext, node: SyntaxNode, exchange: string, routingKey: string): void {
  const routePattern = `amqp:${exchange}/${routingKey}`;
  const evidenceLine = node.startPosition.row + 1;
  const handlerFunctionId = ctx.enclosingFunction?.id ?? null;
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'JOB',
      routePattern,
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
    }),
    httpMethod: 'JOB',
    routePattern,
    handlerFunctionId,
    framework: 'amqp091-go',
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

function emitCaller(ctx: GoVisitContext, node: SyntaxNode, exchange: string, routingKey: string): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = node.startPosition.row + 1;
  const urlLiteral = `amqp:${exchange}/${routingKey}`;
  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      urlLiteral,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    httpMethod: 'JOB',
    urlLiteral,
    egressConfidence: 'exact',
    framework: 'amqp091-go',
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
