import { Node, SyntaxKind, type Node as TsNode } from 'ts-morph';
import { idFor, type ClientSideProcess, type ProcessKind } from '@adorable/schema';
import { type TsFrameworkVisitor, buildEvidence, resolveHandlerToFunctionId } from '@adorable/lang-ts';

/**
 * React framework visitor (#56).
 *
 * Detects two classes of client-side processes in TypeScript / TSX
 * source code and emits canonical `ClientSideProcess` nodes for them:
 *
 *  1. **JSX event handlers** — JSX attributes whose name starts with
 *     `on` (e.g. `onClick`, `onSubmit`, `onChange`). Each matching
 *     attribute on a JSX element yields a `ClientSideProcess` with
 *     `kind: 'event_handler'` and `name` set to the attribute name.
 *
 *  2. **React lifecycle hooks** — call expressions where the callee
 *     is an `Identifier` named `useEffect` or `useLayoutEffect`.
 *     These yield a `ClientSideProcess` with `kind: 'lifecycle_hook'`
 *     and `name` set to the hook name. Other React hooks (`useState`,
 *     `useMemo`, `useCallback`, …) are NOT emitted as processes —
 *     they're state primitives, not event-driven work.
 *
 * Every emitted process is attributed to `ctx.enclosingFunction` via
 * the `functionId` field. A process with no enclosing function
 * (module-top-level JSX, hook called outside a component) is
 * silently skipped because there's nothing meaningful to attribute
 * it to.
 *
 * Process identity is content-addressed by
 * `(sourceFileId, sourceLine, name)` via `idFor.clientSideProcess`,
 * so two visits of the same JSX attribute or hook call collapse into
 * one node at commit time.
 */

/**
 * React lifecycle hook names that map to `kind: 'lifecycle_hook'`
 * `ClientSideProcess` nodes. These hooks' callbacks run in response
 * to rendering / committing DOM updates — i.e. they represent
 * event-driven client-side work worth surfacing as a process. State
 * / memoization primitives (`useState`, `useMemo`, `useCallback`,
 * `useRef`, `useContext`, `useReducer`, …) are intentionally
 * excluded.
 *
 * `useInsertionEffect` (React 18+) is included: from a "process runs
 * during commit" standpoint it behaves identically to
 * `useLayoutEffect`.
 *
 * Known gaps, intentionally deferred to a future type-aware pass:
 *  - Renamed imports: `import { useEffect as useE } from 'react'`
 *    (matched by textual name only).
 *  - Namespaced calls: `React.useEffect(...)` where React is imported
 *    as a namespace (the callee is a `PropertyAccessExpression`).
 *  - Custom hooks that transitively call `useEffect`.
 *  - A local identifier accidentally named `useEffect` will produce a
 *    false-positive lifecycle_hook process.
 */
const LIFECYCLE_HOOKS: ReadonlySet<string> = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
]);

export function createReactVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      // ── JSX event handler attributes ──────────────────────────────
      if (Node.isJsxAttribute(node)) {
        const nameNode = node.getNameNode();
        if (!Node.isIdentifier(nameNode)) return;
        const attrName = nameNode.getText();
        if (!isEventHandlerAttribute(attrName)) return;
        if (!ctx.enclosingFunction) return;

        const process = buildProcess({
          kind: 'event_handler',
          name: attrName,
          ctx,
          sourceLine: node.getStartLineNumber(),
          astNode: node,
        });
        ctx.emitNode(process);

        // Emit TRIGGERS edge to the callback function.
        const targetFnId = resolveJsxAttributeCallback(node, ctx);
        if (targetFnId) {
          ctx.emitEdge({ edgeType: 'TRIGGERS', from: process.id, to: targetFnId });
        }
        return;
      }

      // ── React lifecycle hook calls ────────────────────────────────
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        if (!Node.isIdentifier(callee)) return;
        const hookName = callee.getText();
        if (!LIFECYCLE_HOOKS.has(hookName)) return;
        if (!ctx.enclosingFunction) return;

        const process = buildProcess({
          kind: 'lifecycle_hook',
          name: hookName,
          ctx,
          sourceLine: node.getStartLineNumber(),
          astNode: node,
        });
        ctx.emitNode(process);

        // Emit TRIGGERS edge to the hook's callback function.
        const args = node.getArguments();
        if (args.length > 0) {
          const callback = args[0];
          if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
            // Inline callback — compute the same id the structural extractor used.
            const callbackName = `${ctx.enclosingFunction.name}.${hookName}$callback`;
            const callbackFnId = idFor.functionDefinition({
              sourceFileId: ctx.sourceFile.id,
              name: callbackName,
              sourceLine: callback.getStartLineNumber(),
            });
            ctx.emitEdge({ edgeType: 'TRIGGERS', from: process.id, to: callbackFnId });
          }
        }
        return;
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * React's JSX event-handler naming convention: an attribute name
 * starting with lowercase `on` followed by an uppercase letter (so
 * `onClick` matches but `online` does not).
 */
/**
 * Resolve a JSX attribute's value to a FunctionDefinition id.
 *
 * Handles three forms:
 *   1. Inline arrow: `onClick={() => { ... }}`
 *      → compute the id the structural extractor used for the callback
 *   2. Named reference: `onClick={handleRefresh}`
 *      → resolve the identifier to its declaration's FunctionDefinition id
 *   3. Call expression / other: `onClick={withAuth(handler)}`
 *      → return null (dynamic, cannot resolve statically)
 */
function resolveJsxAttributeCallback(
  attr: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0]
): string | null {
  if (!Node.isJsxAttribute(attr)) return null;
  const initializer = attr.getInitializer();
  if (!initializer || !Node.isJsxExpression(initializer)) return null;

  const expr = initializer.getExpression();
  if (!expr) return null;

  const enclosing = ctx.enclosingFunction!;
  const attrNameNode = attr.getNameNode();
  const attrName = Node.isIdentifier(attrNameNode) ? attrNameNode.getText() : null;

  // Form 1: Inline arrow / function expression
  if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
    if (!attrName) return null;
    const callbackName = `${enclosing.name}.${attrName}$callback`;
    return idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name: callbackName,
      sourceLine: expr.getStartLineNumber(),
    });
  }

  // Form 2: Named reference (identifier). Defer to lang-ts's shared
  // resolver — handles same-file declarations, cross-file imports
  // (#4 — was previously a "Phase 2" gap), path-mapped/aliased
  // imports (via type-checker-first), and skips ambient/.d.ts/
  // node_modules declarations.
  if (Node.isIdentifier(expr)) {
    return resolveHandlerToFunctionId(expr, attr, ctx, 'react');
  }

  return null;
}

function isEventHandlerAttribute(name: string): boolean {
  if (name.length < 3) return false;
  if (!name.startsWith('on')) return false;
  const thirdChar = name.charAt(2);
  return thirdChar >= 'A' && thirdChar <= 'Z';
}

interface BuildProcessArgs {
  kind: ProcessKind;
  name: string;
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0];
  sourceLine: number;
  astNode: TsNode;
}

function buildProcess(args: BuildProcessArgs): ClientSideProcess {
  const { kind, name, ctx, sourceLine, astNode } = args;
  // enclosingFunction is guaranteed non-null by the caller.
  const enclosing = ctx.enclosingFunction!;
  return {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      name,
    }),
    kind,
    name,
    functionId: enclosing.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    framework: 'react',
    repository: ctx.sourceFile.repository,
    evidence: buildEvidence(astNode, ctx.sourceFile.filePath),
  };
}
