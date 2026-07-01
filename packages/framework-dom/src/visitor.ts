import { Node, type CallExpression, type Expression } from 'ts-morph';
import {
  idFor,
  type ClientSideProcess,
  type ProcessKind,
} from '@adorable/schema';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  resolveHandlerToFunctionId,
} from '@adorable/lang-ts';

/**
 * Vanilla-DOM framework visitor (#306).
 *
 * Detects `.addEventListener(<event>, <handler>)` calls in TS source
 * and emits a `ClientSideProcess(kind: 'event_handler')` plus a
 * `TRIGGERS` edge to the handler function.
 *
 * Handler resolution shapes:
 *
 *   .addEventListener('click', onClick)
 *   .addEventListener('click', this.onClick)
 *   .addEventListener('click', this.onClick.bind(this))
 *   .addEventListener('click', (e) => { ... })
 *   .addEventListener('click', async function (e) { ... })
 *
 * The `.bind(this[, ...args])` wrapper is identity-preserving for
 * our purposes — the underlying method is what handles the event,
 * so the TRIGGERS target is the method itself.
 */

const ADD_EVENT_LISTENER = 'addEventListener';

export function createDomVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!isAddEventListenerCall(node)) return;
      if (!ctx.enclosingFunction) return;

      const args = node.getArguments();
      if (args.length < 2) return;

      // First arg: event name. Must be a string literal — computed
      // event names (variables, template strings with interpolation)
      // produce dynamic shapes we can't reason about.
      const eventArg = args[0];
      let eventName: string | null = null;
      if (Node.isStringLiteral(eventArg) || Node.isNoSubstitutionTemplateLiteral(eventArg)) {
        eventName = eventArg.getLiteralValue();
      }
      if (!eventName) return;

      const sourceLine = node.getStartLineNumber();
      const process: ClientSideProcess = buildProcess({
        kind: 'event_handler',
        name: eventName,
        ctx,
        sourceLine,
        astNode: node,
      });
      ctx.emitNode(process);

      // Second arg: the handler. Resolve to a FunctionDefinition id
      // when possible (TRIGGERS edge). Inline arrow / function
      // expressions get no TRIGGERS — the inline body lives inside
      // the enclosing function, which is already the process's
      // `functionId`, so the next-step flow walker can step through.
      const handlerExpr = args[1] as Expression;
      const handlerFunctionId = resolveDomHandler(handlerExpr, node, ctx);
      if (handlerFunctionId) {
        ctx.emitEdge({
          edgeType: 'TRIGGERS',
          from: process.id,
          to: handlerFunctionId,
        });
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Call classification
// ──────────────────────────────────────────────────────────────────────

function isAddEventListenerCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  return callee.getNameNode().getText() === ADD_EVENT_LISTENER;
}

// ──────────────────────────────────────────────────────────────────────
// Handler resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a vanilla-DOM event handler to a FunctionDefinition.id.
 *
 * Handled shapes:
 *   - Inline arrow / function expression → null (no separate fn).
 *   - Identifier (`handler`) → existing cross-file resolver.
 *   - `this.method` PropertyAccessExpression → class method id.
 *   - `<recv>.method.bind(<args>)` → unwrap and recurse on `<recv>.method`.
 *   - `<recv>.method` for an instance field initialized in the
 *     class → method id on the class.
 */
function resolveDomHandler(
  handler: Expression,
  call: CallExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): string | null {
  if (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) {
    return null;
  }
  // Peel `.bind(...)` — the underlying expression is the real handler.
  if (Node.isCallExpression(handler)) {
    const bindCallee = handler.getExpression();
    if (
      Node.isPropertyAccessExpression(bindCallee) &&
      bindCallee.getNameNode().getText() === 'bind'
    ) {
      return resolveDomHandler(bindCallee.getExpression(), call, ctx);
    }
    return null;
  }
  if (Node.isIdentifier(handler)) {
    return resolveHandlerToFunctionId(handler, call, ctx, 'dom');
  }
  if (Node.isPropertyAccessExpression(handler)) {
    return resolveMethodAccess(handler, ctx);
  }
  return null;
}

/**
 * Resolve `<recv>.<method>` to a FunctionDefinition.id when the
 * receiver is `this` (or another expression whose type resolves to
 * a class containing `<method>`). Same-file only — most
 * addEventListener handlers in real codebases live on the
 * enclosing class.
 */
function resolveMethodAccess(
  expr: import('ts-morph').PropertyAccessExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): string | null {
  const methodName = expr.getNameNode().getText();
  const receiver = expr.getExpression();

  // `this.method` — find the enclosing class and look up its method.
  if (Node.isThisExpression(receiver)) {
    const cls = expr.getFirstAncestor(
      (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
    );
    if (!cls) return null;
    if (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls)) return null;
    for (const member of cls.getMembers()) {
      if (Node.isMethodDeclaration(member) && member.getName() === methodName) {
        return idFor.functionDefinition({
          sourceFileId: ctx.sourceFile.id,
          name: methodName,
          sourceLine: member.getStartLineNumber(),
        });
      }
      // Arrow-bound class field: `onClick = (e) => {...}` — these
      // are arrow expressions in a PropertyDeclaration.
      if (Node.isPropertyDeclaration(member) && member.getName() === methodName) {
        const init = member.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          return idFor.functionDefinition({
            sourceFileId: ctx.sourceFile.id,
            name: methodName,
            sourceLine: init.getStartLineNumber(),
          });
        }
      }
    }
    return null;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Process node construction
// ──────────────────────────────────────────────────────────────────────

interface BuildProcessArgs {
  kind: ProcessKind;
  name: string;
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0];
  sourceLine: number;
  astNode: Node;
}

function buildProcess(args: BuildProcessArgs): ClientSideProcess {
  const { kind, name, ctx, sourceLine, astNode } = args;
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
    framework: 'dom',
    repository: ctx.sourceFile.repository,
    evidence: buildEvidence(astNode, ctx.sourceFile.filePath),
  };
}
