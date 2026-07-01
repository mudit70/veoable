import { Node, SyntaxKind } from 'ts-morph';
import { idFor } from '@veoable/schema';
import { type TsFrameworkVisitor, resolveToString } from '@veoable/lang-ts';

/**
 * Redux Saga/Thunk visitor (#133, #61).
 *
 * Detects two patterns and connects them via action type strings:
 *
 *   1. takeLatest(ACTION_TYPE, handlerFn) — saga binding
 *   2. dispatch({ type: ACTION_TYPE }) — component dispatch
 *
 * When both reference the same action type, a CALLS_FUNCTION edge
 * is emitted from the dispatching function to the saga handler,
 * bridging the Redux event system gap.
 *
 * This visitor collects bindings in a first pass, then the
 * getDispatchEdges() method returns edges to emit after all files
 * are processed.
 */

interface SagaBinding {
  actionType: string;
  handlerFnId: string;
  sourceFileId: string;
}

interface DispatchCall {
  actionType: string;
  enclosingFnId: string;
  sourceLine: number;
}

export interface ReduxVisitorWithBindings extends TsFrameworkVisitor {
  getDispatchEdges(): Array<{
    edgeType: 'CALLS_FUNCTION';
    from: string;
    to: string;
    sourceLine: number;
    arguments: string[];
    isConditional: boolean;
    confidence: 'indirect';
  }>;
}

const SAGA_EFFECTS: ReadonlySet<string> = new Set([
  'takeLatest', 'takeEvery', 'takeLeading',
]);

export function createReduxVisitor(): ReduxVisitorWithBindings {
  const sagaBindings: SagaBinding[] = [];
  const dispatchCalls: DispatchCall[] = [];

  return {
    language: 'ts',

    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      const callee = node.getExpression();

      // Pattern 1: takeLatest(ACTION_TYPE, handlerFn)
      if (Node.isIdentifier(callee) && SAGA_EFFECTS.has(callee.getText())) {
        const args = node.getArguments();
        if (args.length >= 2) {
          const actionTypeExpr = args[0];
          const handlerExpr = args[1];

          // Resolve action type to string.
          const actionType = resolveToString(actionTypeExpr);
          if (!actionType) return;

          // Resolve handler to FunctionDefinition ID.
          if (Node.isIdentifier(handlerExpr)) {
            const symbol = handlerExpr.getSymbol();
            if (symbol) {
              const decls = symbol.getDeclarations();
              for (const decl of decls) {
                let fnNode: Node | null = null;
                let fnName: string | null = null;

                if (Node.isFunctionDeclaration(decl)) {
                  fnNode = decl;
                  fnName = decl.getName() ?? null;
                } else if (Node.isVariableDeclaration(decl)) {
                  const init = decl.getInitializer();
                  if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
                    fnNode = init;
                    fnName = decl.getName();
                  }
                }

                if (fnNode && fnName) {
                  const handlerFnId = idFor.functionDefinition({
                    sourceFileId: ctx.sourceFile.id,
                    name: fnName,
                    sourceLine: fnNode.getStartLineNumber(),
                  });
                  sagaBindings.push({
                    actionType,
                    handlerFnId,
                    sourceFileId: ctx.sourceFile.id,
                  });
                }
              }
            }
          }
        }
        return;
      }

      // Pattern 2: dispatch({ type: ACTION_TYPE }) or dispatch(actionCreator())
      if (Node.isIdentifier(callee) && callee.getText() === 'dispatch') {
        if (!ctx.enclosingFunction) return;

        const args = node.getArguments();
        if (args.length === 0) return;
        const arg = args[0];

        // dispatch({ type: 'ACTION_TYPE' })
        if (Node.isObjectLiteralExpression(arg)) {
          for (const prop of arg.getProperties()) {
            if (Node.isPropertyAssignment(prop)) {
              const name = prop.getNameNode();
              if (Node.isIdentifier(name) && name.getText() === 'type') {
                const init = prop.getInitializer();
                if (init) {
                  const actionType = resolveToString(init);
                  if (actionType) {
                    dispatchCalls.push({
                      actionType,
                      enclosingFnId: ctx.enclosingFunction.id,
                      sourceLine: node.getStartLineNumber(),
                    });
                  }
                }
              }
            }
          }
        }

        // dispatch(actionCreator(args)) — resolve the action creator to find the type
        if (Node.isCallExpression(arg)) {
          const acCallee = arg.getExpression();
          if (Node.isIdentifier(acCallee)) {
            // Try to find the action creator function and extract the type from its return value.
            const symbol = acCallee.getSymbol();
            if (symbol) {
              const decls = symbol.getDeclarations();
              for (const decl of decls) {
                // Look for return { type: ACTION_TYPE } in the function body.
                const fnBody = Node.isFunctionDeclaration(decl) ? decl
                  : Node.isVariableDeclaration(decl) ? decl.getInitializer() : null;
                if (!fnBody) continue;

                const returnStmts = fnBody.getDescendantsOfKind(SyntaxKind.ReturnStatement);
                for (const ret of returnStmts) {
                  const retExpr = ret.getExpression();
                  if (retExpr && Node.isObjectLiteralExpression(retExpr)) {
                    for (const prop of retExpr.getProperties()) {
                      if (Node.isPropertyAssignment(prop)) {
                        const pName = prop.getNameNode();
                        if (Node.isIdentifier(pName) && pName.getText() === 'type') {
                          const init = prop.getInitializer();
                          if (init) {
                            const actionType = resolveToString(init);
                            if (actionType) {
                              dispatchCalls.push({
                                actionType,
                                enclosingFnId: ctx.enclosingFunction.id,
                                sourceLine: node.getStartLineNumber(),
                              });
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    getDispatchEdges() {
      const edges: Array<{
        edgeType: 'CALLS_FUNCTION';
        from: string; to: string;
        sourceLine: number; arguments: string[];
        isConditional: boolean; confidence: 'indirect';
      }> = [];

      // Build a map of action type → saga handler.
      const sagaMap = new Map<string, string>();
      for (const binding of sagaBindings) {
        sagaMap.set(binding.actionType, binding.handlerFnId);
      }

      // For each dispatch call, find the matching saga handler.
      for (const call of dispatchCalls) {
        const handlerFnId = sagaMap.get(call.actionType);
        if (handlerFnId) {
          edges.push({
            edgeType: 'CALLS_FUNCTION',
            from: call.enclosingFnId,
            to: handlerFnId,
            sourceLine: call.sourceLine,
            arguments: [call.actionType],
            isConditional: false,
            confidence: 'indirect',
          });
        }
      }

      return edges;
    },
  };
}
