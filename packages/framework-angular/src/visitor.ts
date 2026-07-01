import { Node, SyntaxKind, type Node as TsNode } from 'ts-morph';
import { idFor, type ClientSideProcess, type ProcessKind } from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@veoable/lang-ts';

/**
 * Angular framework visitor (#58).
 *
 * Detects client-side processes in Angular TypeScript source code
 * and emits canonical `ClientSideProcess` nodes.
 *
 * Detection targets:
 *
 *  1. **Angular lifecycle hooks** — method declarations named
 *     `ngOnInit`, `ngOnDestroy`, `ngOnChanges`, `ngAfterViewInit`,
 *     `ngAfterContentInit`, `ngDoCheck`. Each yields a
 *     `ClientSideProcess` with `kind: 'lifecycle_hook'`.
 *
 *  2. **RxJS subscribe calls** — call expressions of the form
 *     `expr.subscribe(...)`. These represent reactive event-driven
 *     work. Yields `kind: 'state_observer'`.
 *
 *  3. **NgRx createEffect calls** — call expressions to `createEffect`
 *     which represent side-effect handlers in NgRx state management.
 *     Yields `kind: 'state_observer'`.
 *
 * Note on enclosingFunction:
 *   The language plugin dispatches visitors BEFORE pushing the current
 *   node onto the function stack. For method declarations, this means
 *   `ctx.enclosingFunction` is the OUTER context (often undefined for
 *   top-level classes). Lifecycle hooks compute their own function ID
 *   using the same ClassName.methodName convention as the structural
 *   extractor.
 */

const LIFECYCLE_HOOKS: ReadonlySet<string> = new Set([
  'ngOnInit',
  'ngOnDestroy',
  'ngOnChanges',
  'ngAfterViewInit',
  'ngAfterViewChecked',
  'ngAfterContentInit',
  'ngAfterContentChecked',
  'ngDoCheck',
]);

export function createAngularVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      // ── Angular lifecycle hooks ──────────────────────────────────
      if (Node.isMethodDeclaration(node)) {
        const name = node.getName();
        if (!LIFECYCLE_HOOKS.has(name)) return;

        // Compute the function ID using the same naming convention
        // the structural extractor uses: ClassName.methodName.
        const functionId = computeMethodFunctionId(node, ctx);
        if (!functionId) return;

        const process: ClientSideProcess = {
          nodeType: 'ClientSideProcess',
          id: idFor.clientSideProcess({
            sourceFileId: ctx.sourceFile.id,
            sourceLine: node.getStartLineNumber(),
            name,
          }),
          kind: 'lifecycle_hook',
          name,
          functionId,
          sourceFileId: ctx.sourceFile.id,
          sourceLine: node.getStartLineNumber(),
          framework: 'angular',
          repository: ctx.sourceFile.repository,
          evidence: buildEvidence(node, ctx.sourceFile.filePath),
        };
        ctx.emitNode(process);
        return;
      }

      // ── RxJS subscribe / NgRx createEffect calls ─────────────────
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        // Pattern: expr.subscribe(...)
        // m5: Narrowed to reduce false positives — only match when the
        // receiver is a .pipe() result, a this.* property access, or a
        // method call (e.g., this.service.getUsers().subscribe()).
        // This avoids matching EventEmitter.subscribe() or other
        // non-RxJS subscribe calls.
        if (Node.isPropertyAccessExpression(callee)) {
          const methodName = callee.getNameNode().getText();
          if (methodName === 'subscribe') {
            if (!ctx.enclosingFunction) return;
            if (!isLikelyRxJsReceiver(callee)) return;

            const process = buildProcess({
              kind: 'state_observer',
              name: 'subscribe',
              ctx,
              sourceLine: node.getStartLineNumber(),
              astNode: node,
            });
            ctx.emitNode(process);
            return;
          }
        }

        // Pattern: createEffect(() => ...)
        if (Node.isIdentifier(callee) && callee.getText() === 'createEffect') {
          // createEffect may be in a property initializer (no enclosingFunction)
          // or in a method body. Use enclosingFunction if available, otherwise
          // try to find the enclosing class property to compute a function ID.
          const functionId = ctx.enclosingFunction?.id ?? computePropertyInitializerFunctionId(node, ctx);
          if (!functionId) return;

          const process: ClientSideProcess = {
            nodeType: 'ClientSideProcess',
            id: idFor.clientSideProcess({
              sourceFileId: ctx.sourceFile.id,
              sourceLine: node.getStartLineNumber(),
              name: 'createEffect',
            }),
            kind: 'state_observer',
            name: 'createEffect',
            functionId,
            sourceFileId: ctx.sourceFile.id,
            sourceLine: node.getStartLineNumber(),
            framework: 'angular',
            repository: ctx.sourceFile.repository,
            evidence: buildEvidence(node, ctx.sourceFile.filePath),
          };
          ctx.emitNode(process);
          return;
        }
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Compute the FunctionDefinition id for a class method declaration
 * using the same naming convention as the structural extractor:
 * `ClassName.methodName`.
 */
function computeMethodFunctionId(
  method: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0]
): string | null {
  if (!Node.isMethodDeclaration(method)) return null;

  const cls = method.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  if (!cls) return null;

  const className = cls.getName() ?? '<anonymous-class>';
  const methodName = method.getName();
  const name = `${className}.${methodName}`;

  return idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name,
    sourceLine: method.getStartLineNumber(),
  });
}

/**
 * For createEffect in a class property initializer, compute a function ID
 * from the enclosing class and property name.
 */
function computePropertyInitializerFunctionId(
  node: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0]
): string | null {
  const propDecl = node.getFirstAncestorByKind(SyntaxKind.PropertyDeclaration);
  if (!propDecl) return null;

  const cls = propDecl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  if (!cls) return null;

  const className = cls.getName() ?? '<anonymous-class>';
  const propName = propDecl.getName();

  // The structural extractor doesn't emit FunctionDefinitions for property
  // initializers, but we still need a function ID for attribution.
  // Use the class constructor as the attributing function since property
  // initializers run during construction.
  return idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name: `${className}.constructor`,
    sourceLine: cls.getStartLineNumber(),
  });
}

/**
 * Heuristic to identify likely RxJS Observable receivers for .subscribe().
 *
 * Returns true when the receiver of .subscribe() is:
 *   - A .pipe() call result: `obs.pipe(...).subscribe()`
 *   - A method call: `this.service.getUsers().subscribe()`
 *   - A this.* property: `this.data$.subscribe()`
 *
 * Returns false for plain identifiers like `emitter.subscribe()` which
 * are more likely non-RxJS event emitters.
 */
function isLikelyRxJsReceiver(callee: TsNode): boolean {
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const receiver = callee.getExpression();

  // expr.pipe(...).subscribe() — very strong RxJS signal
  if (Node.isCallExpression(receiver)) {
    const innerCallee = receiver.getExpression();
    if (Node.isPropertyAccessExpression(innerCallee)) {
      const innerMethodName = innerCallee.getNameNode().getText();
      if (innerMethodName === 'pipe') return true;
    }
    // Any method call result .subscribe() — likely Observable
    return true;
  }

  // this.something.subscribe() or this.something$.subscribe()
  if (Node.isPropertyAccessExpression(receiver)) {
    return true;
  }

  // someVar.subscribe() — could be anything, accept it (conservative)
  return true;
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
    framework: 'angular',
    repository: ctx.sourceFile.repository,
    evidence: buildEvidence(astNode, ctx.sourceFile.filePath),
  };
}
