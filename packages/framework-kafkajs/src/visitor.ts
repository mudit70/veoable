import { Node, type Expression, type ObjectLiteralExpression, type PropertyAssignment } from 'ts-morph';
import {
  idFor,
  type APIEndpoint,
  type ClientSideAPICaller,
} from '@adorable/schema';
import {
  buildEvidence,
  readStringLiteral,
  type TsFrameworkVisitor,
  type TsVisitContext,
} from '@adorable/lang-ts';

/**
 * kafkajs visitor.
 *
 * Detection paths:
 *
 * 1. **Producer**: `<p>.send({ topic, messages })` and
 *    `<p>.sendBatch({ topicMessages: [{ topic, messages }, ...] })`.
 *    Each literal topic emits one `ClientSideAPICaller`.
 *
 * 2. **Consumer**: `<c>.subscribe({ topic })` and
 *    `<c>.subscribe({ topics: [...] })`. Each literal topic emits
 *    one `APIEndpoint`.
 *
 * Per-file gate: file must `import ... from 'kafkajs'` so unrelated
 * `.send({ topic })` calls in other libraries don't false-match.
 *
 * URL convention: `kafka:<topic>` — mirrors kafkapy/kafkago/kafkars
 * so the flow stitcher pairs producer↔consumer by exact URL match.
 */
export function createKafkajsVisitor(): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();

  const fileImportsKafka = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const decls = sf.getImportDeclarations();
    const has = decls.some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === 'kafkajs' || spec.startsWith('kafkajs/');
    });
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!fileImportsKafka(node, ctx.sourceFile.filePath)) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const methodName = callee.getNameNode().getText();

      // Producer: <p>.send({ topic, messages })
      if (methodName === 'send') {
        if (!ctx.enclosingFunction) return;
        const opts = firstObjectLiteralArg(node.getArguments());
        if (!opts) return;
        const topic = readPropertyStringLiteral(opts, 'topic');
        if (topic === null) return;
        emitCaller(ctx, node, topic);
        return;
      }

      // Producer: <p>.sendBatch({ topicMessages: [{ topic, ... }, ...] })
      if (methodName === 'sendBatch') {
        if (!ctx.enclosingFunction) return;
        const opts = firstObjectLiteralArg(node.getArguments());
        if (!opts) return;
        const topics = readNestedTopicMessagesTopics(opts);
        for (const topic of topics) emitCaller(ctx, node, topic);
        return;
      }

      // Consumer: <c>.subscribe({ topic }) | <c>.subscribe({ topics: [...] })
      if (methodName === 'subscribe') {
        const opts = firstObjectLiteralArg(node.getArguments());
        if (!opts) return;
        const single = readPropertyStringLiteral(opts, 'topic');
        if (single !== null) {
          emitEndpoint(ctx, node, single);
          return;
        }
        const many = readPropertyStringArray(opts, 'topics');
        for (const topic of many) emitEndpoint(ctx, node, topic);
        return;
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

function readPropertyStringArray(obj: ObjectLiteralExpression, name: string): string[] {
  const prop = obj.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return [];
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init || !Node.isArrayLiteralExpression(init)) return [];
  const out: string[] = [];
  for (const el of init.getElements()) {
    const s = readStringLiteral(el);
    if (s !== null) out.push(s);
  }
  return out;
}

/**
 * For `sendBatch({ topicMessages: [{ topic: 'a', ... }, { topic: 'b', ... }] })`,
 * extract each inner `topic` literal. Misses object spreads, identifier
 * references, etc. — only matches inline object literals with literal topics.
 */
function readNestedTopicMessagesTopics(obj: ObjectLiteralExpression): string[] {
  const prop = obj.getProperty('topicMessages');
  if (!prop || !Node.isPropertyAssignment(prop)) return [];
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init || !Node.isArrayLiteralExpression(init)) return [];
  const out: string[] = [];
  for (const el of init.getElements()) {
    if (!Node.isObjectLiteralExpression(el)) continue;
    const t = readPropertyStringLiteral(el, 'topic');
    if (t !== null) out.push(t);
  }
  return out;
}

function emitEndpoint(ctx: TsVisitContext, node: Node, topic: string): void {
  const routePattern = `kafka:${topic}`;
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
    framework: 'kafkajs',
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(endpoint);
}

function emitCaller(ctx: TsVisitContext, node: Node, topic: string): void {
  if (!ctx.enclosingFunction) return;
  const urlLiteral = `kafka:${topic}`;
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
    framework: 'kafkajs',
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
