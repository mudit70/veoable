import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

/**
 * pika visitor.
 *
 * Producer:
 *   channel.basic_publish(exchange='X', routing_key='K', body=b'...')
 *
 * Consumer:
 *   channel.basic_consume(queue='Q', on_message_callback=...)
 *
 * Per-file gate: `import pika` / `from pika import ...`.
 */
export function createPikaVisitor(): PyFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    let has = false;
    for (let i = 0; i < root.childCount; i++) {
      const c = root.child(i);
      if (!c) continue;
      if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
      if (/\bpika\b/.test(c.text)) { has = true; break; }
    }
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') return;
      const attr = fn.childForFieldName('attribute');
      if (!attr) return;
      const args = node.childForFieldName('arguments');
      if (!args) return;

      if (attr.text === 'basic_publish') {
        if (!ctx.enclosingFunction) return;
        const exchange = findKwarg(args, 'exchange');
        const routingKey = findKwarg(args, 'routing_key');
        if (exchange === null || routingKey === null) return;
        emitCaller(ctx, node, exchange, routingKey);
        return;
      }

      if (attr.text === 'basic_consume') {
        const queue = findKwarg(args, 'queue');
        if (queue === null) return;
        emitEndpoint(ctx, node, '', queue);
        return;
      }
    },
  };
}

function findKwarg(args: SyntaxNode, name: string): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c || c.type !== 'keyword_argument') continue;
    const nameNode = c.childForFieldName('name');
    const valueNode = c.childForFieldName('value');
    if (nameNode?.text !== name) continue;
    if (valueNode?.type === 'string') return stripPythonString(valueNode.text);
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

function emitEndpoint(ctx: PyVisitContext, node: SyntaxNode, exchange: string, routingKey: string): void {
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
    framework: 'pika',
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

function emitCaller(ctx: PyVisitContext, callNode: SyntaxNode, exchange: string, routingKey: string): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = callNode.startPosition.row + 1;
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
    framework: 'pika',
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
