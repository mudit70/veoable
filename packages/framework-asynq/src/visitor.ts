import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@adorable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';

/**
 * asynq visitor — Go task queue (producer + consumer pairs).
 *
 * Consumer side (→ APIEndpoint, httpMethod='JOB'):
 *   mux := asynq.NewServeMux()
 *   mux.HandleFunc("user:welcome", handleWelcome)
 *   mux.Handle("user:onboard", asynq.HandlerFunc(handleOnboard))
 *
 * Producer side (→ ClientSideAPICaller, httpMethod='JOB'):
 *   task := asynq.NewTask("user:welcome", payload)
 *   client.Enqueue(task)
 *
 * The PRODUCER detection works in two steps:
 *   1. Per-file scan for `<name> := asynq.NewTask("type:name", ...)`.
 *      Builds a map `<var> → 'type:name'`.
 *   2. On any `<client>.Enqueue(<var>)` call, look up <var> in the
 *      map and emit ClientSideAPICaller with the matching task type.
 *
 * Per-file gate: file must import `github.com/hibiken/asynq`.
 *
 * routePattern / urlLiteral: `asynq:<task-type>` — same convention
 * celery/bullmq use, so the flow-stitcher's exact-match path
 * connects them.
 *
 * Conservative v1 limit: the binding scanner is per-file flat. Two
 * helper functions that bind a variable with the SAME name to
 * different task types will conflate (last write wins). Real-world
 * code typically uses distinct helper-var names — `welcomeTask`
 * vs `onboardTask` — and the fixture mirrors that idiom. A v2
 * follow-up could scope the scanner to the enclosing function.
 */

/**
 * Methods that enqueue an asynq.Task, mapped to the positional
 * index of the task argument. All share the same task-arg shape;
 * Context-bearing variants take ctx first.
 *
 *   Enqueue(task, opts...)             → idx 0
 *   EnqueueContext(ctx, task, opts...) → idx 1
 *   Schedule(task, processAt)          → idx 0
 *   EnqueueIn(delay, task, opts...)    → idx 1
 *   EnqueueAt(processAt, task, opts...)→ idx 1
 */
const ENQUEUE_VARIANTS: ReadonlyMap<string, number> = new Map([
  ['Enqueue', 0],
  ['EnqueueContext', 1],
  ['Schedule', 0],
  ['EnqueueIn', 1],
  ['EnqueueAt', 1],
]);

export function createAsynqVisitor(): GoFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const taskBindingsByFile = new Map<string, Map<string, string>>();

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = scanFileImports(root);
    importsByFile.set(filePath, value);
    return value;
  };

  const getTaskBindings = (filePath: string, root: SyntaxNode): Map<string, string> => {
    let m = taskBindingsByFile.get(filePath);
    if (!m) {
      m = scanFileForTaskBindings(root);
      taskBindingsByFile.set(filePath, m);
    }
    return m;
  };

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'selector_expression') return;
      const field = fn.childForFieldName('field');
      const operand = fn.childForFieldName('operand');
      if (!field || !operand) return;

      const methodName = field.text;
      const args = node.childForFieldName('arguments');

      // ── Consumer: mux.HandleFunc("type:name", handler) ─────
      // ── Consumer: mux.Handle("type:name", handler) ─────────
      if (methodName === 'HandleFunc' || methodName === 'Handle') {
        if (!args) return;
        // Receiver should look like a mux (`mux`, `serveMux`, etc.).
        // The asynq-import gate keeps this from false-positive-ing
        // on net/http muxes.
        if (!isMuxReceiver(operand.text)) return;
        const taskType = readStringLiteralArg(args, 0);
        if (!taskType) return;
        emitEndpoint(ctx, node, taskType);
        return;
      }

      // ── Producer: client.Enqueue / EnqueueContext / Schedule /
      //   EnqueueIn / EnqueueAt (all share the task-arg shape).
      const taskArgIdx = ENQUEUE_VARIANTS.get(methodName);
      if (taskArgIdx !== undefined) {
        if (!args) return;
        const taskBindings = getTaskBindings(ctx.sourceFile.filePath, node.tree.rootNode);
        const taskArg = nthArg(args, taskArgIdx);
        if (!taskArg) return;
        let taskType: string | null = null;
        if (taskArg.type === 'identifier') {
          taskType = taskBindings.get(taskArg.text) ?? null;
        } else if (taskArg.type === 'call_expression') {
          // Inline: `client.Enqueue(asynq.NewTask("type", payload))`.
          taskType = resolveNewTaskCall(taskArg);
        }
        if (!taskType) return;
        emitCaller(ctx, node, taskType);
        return;
      }
    },
  };
}

function isMuxReceiver(text: string): boolean {
  // Accept any name containing `mux` (case-insensitive) plus the
  // canonical bare names. The asynq-import gate provides the
  // outer safety net.
  return /^(?:[a-zA-Z_][\w]*\.)?(?:.*[Mm]ux.*|server|srv)$/.test(text);
}

function emitEndpoint(
  ctx: GoVisitContext,
  evidenceNode: SyntaxNode,
  taskType: string,
): void {
  const evidenceLine = evidenceNode.startPosition.row + 1;
  const routePattern = `asynq:${taskType}`;
  // handlerFunctionId stays null — Go handler resolution to a
  // FunctionDefinition lives downstream (lang-go's function
  // registry isn't exposed to visitors). Same approach gohttp's
  // server-side handlers take.
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
    handlerFunctionId: null,
    framework: 'asynq',
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

function emitCaller(
  ctx: GoVisitContext,
  callNode: SyntaxNode,
  taskType: string,
): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = callNode.startPosition.row + 1;
  const routePattern = `asynq:${taskType}`;
  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      urlLiteral: routePattern,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    httpMethod: 'JOB',
    urlLiteral: routePattern,
    egressConfidence: 'exact',
    framework: 'asynq',
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

function nthArg(args: SyntaxNode, index: number): SyntaxNode | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === index) return c;
    seen++;
  }
  return null;
}

function readStringLiteralArg(args: SyntaxNode, index: number): string | null {
  const arg = nthArg(args, index);
  if (!arg) return null;
  if (arg.type === 'interpreted_string_literal' || arg.type === 'raw_string_literal') {
    return arg.text.slice(1, -1);
  }
  return null;
}


/**
 * Recognize `asynq.NewTask("type:name", ...)` and return the task
 * type string literal.
 */
function resolveNewTaskCall(callNode: SyntaxNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'selector_expression') return null;
  const operand = fn.childForFieldName('operand');
  const field = fn.childForFieldName('field');
  if (operand?.text !== 'asynq' || field?.text !== 'NewTask') return null;
  const args = callNode.childForFieldName('arguments');
  if (!args) return null;
  return readStringLiteralArg(args, 0);
}

function scanFileForTaskBindings(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'short_var_declaration' || n.type === 'assignment_statement') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left && right) {
        const lefts = expressionListChildren(left);
        const rights = expressionListChildren(right);
        for (let i = 0; i < Math.min(lefts.length, rights.length); i++) {
          if (rights[i].type === 'call_expression') {
            const taskType = resolveNewTaskCall(rights[i]);
            if (taskType) {
              const name = lefts[i].text;
              out.set(name, taskType);
            }
          }
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(rootNode);
  return out;
}

function expressionListChildren(node: SyntaxNode): SyntaxNode[] {
  if (node.type === 'expression_list') {
    const out: SyntaxNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c || c.type === ',') continue;
      out.push(c);
    }
    return out;
  }
  return [node];
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type === 'import_declaration' && c.text.includes('hibiken/asynq')) return true;
  }
  return false;
}
