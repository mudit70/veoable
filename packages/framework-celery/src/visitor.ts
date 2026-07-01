import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@adorable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@adorable/lang-py';

/**
 * Celery visitor — task definitions + task invocations in one pass.
 *
 * Consumer side (task definitions) → APIEndpoint:
 *   @app.task                                  → name = function_name
 *   @app.task(name='upload.process')           → name = 'upload.process'
 *   @shared_task                               → name = function_name
 *   @celery.task                               → name = function_name
 *
 * Producer side (task invocations) → ClientSideAPICaller:
 *   <task>.delay(...)                         → urlLiteral = function name lookup
 *   <task>.apply_async(args=[...])             → same
 *   app.send_task('upload.process', ...)       → urlLiteral = string arg
 *
 * For `.delay()` / `.apply_async()` we don't statically resolve
 * which task object is the receiver. The default convention is that
 * the receiver name IS the task name (the function name). Production
 * code often imports tasks under their own name, so `process_upload
 * .delay(...)` calls a task whose name is also `process_upload`. We
 * use the receiver text directly as the urlLiteral fallback.
 *
 * The stitcher's exact-match path joins `urlLiteral === routePattern`
 * — same convention bullmq uses.
 */

const TASK_DECORATORS: ReadonlySet<string> = new Set(['task', 'shared_task']);

export function createCeleryVisitor(): PyFrameworkVisitor {
  // Per-file gate. Celery activation is project-wide (manifest), but
  // we only emit in files that actually import celery to avoid
  // collisions with unrelated decorators in files that share the
  // project but don't use celery directly.
  const importsByFile = new Map<string, boolean>();
  const fileImportsCelery = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = scanFileImportsCelery(root);
    importsByFile.set(filePath, value);
    return value;
  };

  // Per-file map: function-name → resolved task name. Built by a
  // pre-scan of every decorated_definition. Consulted by handleCall
  // so an explicit `name='upload.process'` on the decorator flows
  // through to the producer's urlLiteral and matches the consumer's
  // routePattern (the flow-stitcher's exact-match key).
  const taskNameByFile = new Map<string, Map<string, string>>();
  const getTaskNames = (filePath: string, root: SyntaxNode): Map<string, string> => {
    let m = taskNameByFile.get(filePath);
    if (!m) {
      m = scanFileForTaskNames(root);
      taskNameByFile.set(filePath, m);
    }
    return m;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (!fileImportsCelery(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      // ── Task definition (consumer side) ─────────────────────────
      if (node.type === 'decorated_definition') {
        handleDecoratedDef(ctx, node);
        return;
      }

      // ── Task invocation (producer side) ─────────────────────────
      if (node.type === 'call') {
        const taskNameMap = getTaskNames(ctx.sourceFile.filePath, node.tree.rootNode);
        handleCall(ctx, node, taskNameMap);
        return;
      }
    },
  };
}

function handleDecoratedDef(ctx: PyVisitContext, node: SyntaxNode): void {
  const decorators = node.children.filter((c) => c.type === 'decorator');
  const fnDef = node.childForFieldName('definition');
  if (!fnDef || fnDef.type !== 'function_definition') return;

  for (const dec of decorators) {
    const parsed = parseTaskDecorator(dec);
    if (!parsed) continue;

    const nameNode = fnDef.childForFieldName('name');
    const fnName = nameNode?.text ?? 'handler';
    const fnLine = fnDef.startPosition.row + 1;

    // Task name: explicit `name='...'` arg wins, otherwise function name.
    const taskName = parsed.explicitName ?? fnName;

    emitEndpoint(ctx, dec, taskName, fnName, fnLine);
  }
}

interface TaskDecoratorResult {
  explicitName: string | null;
}

function parseTaskDecorator(decorator: SyntaxNode): TaskDecoratorResult | null {
  // Two shapes:
  //   @<recv>.task         → identifier or attribute
  //   @<recv>.task(...)    → call wrapping the above
  //   @shared_task          → bare identifier
  //   @shared_task(...)    → bare with args
  let inner: SyntaxNode | null = null;
  for (const c of decorator.children) {
    if (c.type === 'attribute' || c.type === 'identifier' || c.type === 'call') {
      inner = c;
      break;
    }
  }
  if (!inner) return null;

  if (inner.type === 'call') {
    const fn = inner.childForFieldName('function');
    if (!fn) return null;
    if (!isTaskDecoratorTarget(fn)) return null;
    const args = inner.childForFieldName('arguments');
    return { explicitName: args ? findKwarg(args, 'name') : null };
  }

  return isTaskDecoratorTarget(inner) ? { explicitName: null } : null;
}

function isTaskDecoratorTarget(node: SyntaxNode): boolean {
  // `task` / `shared_task` as bare identifier.
  if (node.type === 'identifier') return TASK_DECORATORS.has(node.text);
  // `<recv>.task` / `<recv>.shared_task` as attribute.
  if (node.type === 'attribute') {
    const attr = node.childForFieldName('attribute');
    if (!attr) return false;
    return TASK_DECORATORS.has(attr.text);
  }
  return false;
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

function handleCall(
  ctx: PyVisitContext,
  node: SyntaxNode,
  taskNameMap: ReadonlyMap<string, string>,
): void {
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return;

  const obj = fn.childForFieldName('object');
  const attr = fn.childForFieldName('attribute');
  if (!obj || !attr) return;

  const methodName = attr.text;

  // ── `<task>.delay(...)` / `<task>.apply_async(...)` ──
  if (methodName === 'delay' || methodName === 'apply_async') {
    const receiverText = obj.text;
    if (obj.type !== 'identifier' && obj.type !== 'attribute') return;
    // Receiver is either a bare function name (`process_upload`) or
    // a dotted path (`tasks.process_upload`). The LAST segment is
    // the function name. Consult the per-file map FIRST so an
    // explicit `name='upload.process'` on the consumer decorator
    // flows through to the producer's urlLiteral (matching the
    // consumer's routePattern). Falls back to the raw receiver name
    // if the map has no entry (decorator + call in different files).
    const fnName = lastDottedSegment(receiverText);
    const taskName = taskNameMap.get(fnName) ?? fnName;
    emitCaller(ctx, node, taskName);
    return;
  }

  // ── `app.send_task('name', ...)` / `app.send_task(name='name')` ──
  if (methodName === 'send_task') {
    const args = node.childForFieldName('arguments');
    if (!args) return;
    const taskName = firstStringArg(args) ?? findKwarg(args, 'name');
    if (taskName === null) return;
    emitCaller(ctx, node, taskName);
    return;
  }
}

function emitEndpoint(
  ctx: PyVisitContext,
  evidenceNode: SyntaxNode,
  taskName: string,
  handlerName: string,
  handlerLine: number,
): void {
  const routePattern = `celery:${taskName}`;
  const handlerFunctionId = idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name: handlerName,
    sourceLine: handlerLine,
  });
  const evidenceLine = evidenceNode.startPosition.row + 1;

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
    framework: 'celery',
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
  ctx: PyVisitContext,
  callNode: SyntaxNode,
  taskName: string,
): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = callNode.startPosition.row + 1;
  const routePattern = `celery:${taskName}`;

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
    framework: 'celery',
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

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === 'string' || c.type === 'concatenated_string') {
      return stripPythonString(c.text);
    }
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    return null;
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

function lastDottedSegment(text: string): string {
  const i = text.lastIndexOf('.');
  return i >= 0 ? text.slice(i + 1) : text;
}

/**
 * Pre-scan every `decorated_definition` in the file for celery task
 * decorators. Returns a map of `function_name → resolved_task_name`
 * so producer-side calls (`.delay()`, `.apply_async()`) can look up
 * the explicit `name=` from the consumer decorator. Without this,
 * `@app.task(name='upload.process') def explicit_name(): ...` plus
 * `explicit_name.apply_async(...)` would never stitch — the producer
 * urlLiteral would be `celery:explicit_name` but the consumer's
 * routePattern is `celery:upload.process`.
 */
function scanFileForTaskNames(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'decorated_definition') {
      const decorators = n.children.filter((c) => c.type === 'decorator');
      const fnDef = n.childForFieldName('definition');
      if (fnDef && fnDef.type === 'function_definition') {
        const nameNode = fnDef.childForFieldName('name');
        const fnName = nameNode?.text;
        if (fnName) {
          for (const dec of decorators) {
            const parsed = parseTaskDecorator(dec);
            if (parsed?.explicitName) {
              out.set(fnName, parsed.explicitName);
              break;
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

function scanFileImportsCelery(root: SyntaxNode): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (!c) continue;
    if (c.type === 'import_statement' || c.type === 'import_from_statement') {
      if (c.text.includes('celery')) return true;
    }
  }
  return false;
}
