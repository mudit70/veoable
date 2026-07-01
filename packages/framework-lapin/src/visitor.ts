import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@veoable/schema';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@veoable/lang-rust';

/**
 * lapin (Rust) visitor.
 *
 * Producer:
 *   channel.basic_publish("exchange", "routing.key", options, payload, props)
 *   — first two positional args are `exchange` then `routing_key`. Both
 *   must be string literals to emit (skip on partial-literal pairs).
 *
 * Consumer:
 *   channel.basic_consume("queue", "consumer-tag", options, args)
 *   — first positional arg is `queue`.
 *
 * The call's function is a `field_expression` whose `field` is the
 * method name; arguments are positional after a `&self` receiver. The
 * tree-sitter `arguments` node interleaves `(`, `,`, `)` punctuation.
 *
 * Per-file gate: `use lapin` (any nested lapin import). Without this,
 * a `basic_publish` or `basic_consume` method on an unrelated type
 * would falsely emit on the same project.
 */
export function createLapinVisitor(): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = hasCrateImport(root, 'lapin');
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'field_expression') return;
      const field = fn.childForFieldName('field');
      if (!field) return;
      const args = node.childForFieldName('arguments');
      if (!args) return;

      const method = field.text;

      if (method === 'basic_publish') {
        if (!ctx.enclosingFunction) return;
        const exchange = stringArgAt(args, 0);
        const routingKey = stringArgAt(args, 1);
        if (exchange === null || routingKey === null) return;
        emitCaller(ctx, node, exchange, routingKey);
        return;
      }

      if (method === 'basic_consume') {
        const queue = stringArgAt(args, 0);
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
      if (c.type === 'string_literal' || c.type === 'raw_string_literal') {
        return stripRustString(c.text);
      }
      return null;
    }
    seen++;
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

function emitEndpoint(ctx: RustVisitContext, node: SyntaxNode, exchange: string, routingKey: string): void {
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
    framework: 'lapin',
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

function emitCaller(ctx: RustVisitContext, node: SyntaxNode, exchange: string, routingKey: string): void {
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
    framework: 'lapin',
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
