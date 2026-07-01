import { Node, type Expression } from 'ts-morph';
import {
  idFor,
  type APIEndpoint,
  type ClientSideAPICaller,
} from '@adorable/schema';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  readStringLiteral,
  resolveHandlerToFunctionId,
} from '@adorable/lang-ts';

/**
 * BullMQ framework visitor (#110).
 *
 * Models BullMQ producer / consumer pairs as if they were HTTP
 * caller / endpoint, so the existing flow stitcher can connect
 * them.
 *
 *   // producer
 *   const queue = new Queue('uploads', { connection });
 *   await queue.add('process-upload', payload);
 *     → ClientSideAPICaller (urlLiteral='bullmq:uploads', httpMethod='JOB')
 *
 *   // consumer
 *   new Worker('uploads', async (job) => { ... }, { connection });
 *     → APIEndpoint (routePattern='bullmq:uploads', httpMethod='JOB')
 *
 * The flow stitcher's exact-match path connects these by
 * urlLiteral === routePattern. Per-job-name granularity (matching on
 * the job-name argument to `.add()`) is out of scope for the first
 * iteration; the worker handler typically branches on `job.name`
 * internally, which our static analysis can't always resolve.
 *
 * Detection is conservative:
 *   - Receiver of `.add()` must resolve to a `new Queue(<string>, ...)`
 *     binding in the same file.
 *   - Worker construction is matched on the callee text (`Worker`,
 *     namespace `bullmq.Worker`, etc.) plus a string-literal first
 *     argument.
 */
export function createBullmqVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      // ── `new Worker('queueName', handler, opts?)` → APIEndpoint ──
      if (Node.isNewExpression(node)) {
        const callee = node.getExpression();
        let calleeName: string | null = null;
        if (Node.isIdentifier(callee)) calleeName = callee.getText();
        else if (Node.isPropertyAccessExpression(callee)) calleeName = callee.getNameNode().getText();
        if (calleeName !== 'Worker') return;

        const args = node.getArguments();
        if (args.length < 2) return;
        const queueName = readStringLiteral(args[0]);
        if (!queueName) return;

        const handlerExpr = args[1] as Expression;
        const handlerFunctionId = resolveHandlerToFunctionId(handlerExpr, node, ctx, 'bullmq');

        const routePattern = `bullmq:${queueName}`;
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
          handlerFunctionId,
          framework: 'bullmq',
          repository: ctx.sourceFile.repository,
          evidence,
        };
        ctx.emitNode(endpoint);
        return;
      }

      // ── `<queue>.add('job-name', payload, opts?)` → ClientSideAPICaller ──
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) return;
        if (callee.getNameNode().getText() !== 'add') return;
        if (!ctx.enclosingFunction) return;

        const receiver = callee.getExpression();
        if (!Node.isIdentifier(receiver)) return;
        const queueName = resolveQueueIdentifierName(receiver);
        if (!queueName) return;

        const args = node.getArguments();
        if (readStringLiteral(args[0]) === null) {
          // Job-name not a literal — record but don't emit; the queue
          // binding succeeded so we know it's a BullMQ call.
          return;
        }

        const urlLiteral = `bullmq:${queueName}`;
        const caller: ClientSideAPICaller = {
          nodeType: 'ClientSideAPICaller',
          id: idFor.clientSideAPICaller({
            sourceFileId: ctx.sourceFile.id,
            sourceLine: node.getStartLineNumber(),
            urlLiteral,
          }),
          functionId: ctx.enclosingFunction.id,
          sourceFileId: ctx.sourceFile.id,
          sourceLine: node.getStartLineNumber(),
          httpMethod: 'JOB',
          urlLiteral,
          egressConfidence: 'exact',
          framework: 'bullmq',
          repository: ctx.sourceFile.repository,
          evidence: buildEvidence(node, ctx.sourceFile.filePath),
        };
        ctx.emitNode(caller);
        ctx.emitEdge({
          edgeType: 'MAKES_REQUEST',
          from: ctx.enclosingFunction.id,
          to: caller.id,
        });
      }
    },
  };
}

/**
 * Resolve a `<id>` Identifier to the queue name passed to
 * `new Queue('<name>', ...)` when `<id>` is bound to it. Returns null
 * when:
 *   - the symbol resolves to a different shape,
 *   - the constructor's first arg is not a string literal,
 *   - the binding lives in another file (cross-file resolution is
 *     out of scope here).
 */
function resolveQueueIdentifierName(ident: Node): string | null {
  if (!Node.isIdentifier(ident)) return null;
  const sym = ident.getSymbol();
  if (!sym) return null;
  for (const d of sym.getDeclarations()) {
    if (!Node.isVariableDeclaration(d)) continue;
    if (d.getSourceFile() !== ident.getSourceFile()) continue;
    const init = d.getInitializer();
    if (!init || !Node.isNewExpression(init)) continue;
    const newCallee = init.getExpression();
    let name: string | null = null;
    if (Node.isIdentifier(newCallee)) name = newCallee.getText();
    else if (Node.isPropertyAccessExpression(newCallee)) name = newCallee.getNameNode().getText();
    if (name !== 'Queue') continue;
    const args = init.getArguments();
    const literal = readStringLiteral(args[0]);
    if (literal !== null) return literal;
  }
  return null;
}
