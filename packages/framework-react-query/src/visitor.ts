import {
  Node,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type Expression,
} from 'ts-morph';
import { idFor, type ClientSideProcess } from '@veoable/schema';
import {
  type TsFrameworkVisitor,
  type TsVisitContext,
  buildEvidence,
  resolveFunctionDefinitionIdFromDecl,
} from '@veoable/lang-ts';

/**
 * React Query hook visitor (#549).
 *
 * Detects calls to the hooks in `HOOK_TO_FN_KEY` and emits:
 *
 *   - One `ClientSideProcess` (kind: 'event_handler') per hook call,
 *     attributed to the enclosing function (the React component or
 *     custom hook in which the call appears).
 *   - One `TRIGGERS` edge from that process to the resolved
 *     `mutationFn`/`queryFn` callback, so the flow walker can walk
 *     process → callback → fetch → endpoint.
 *
 * Callback resolution covers three shapes:
 *
 *   1. Inline arrow / function expression:
 *        useMutation({ mutationFn: (input) => createOrder(input) })
 *      → TRIGGERS edge points to the arrow's synthetic
 *        FunctionDefinition id (lang-ts emits one per arrow).
 *
 *   2. Bare identifier reference:
 *        useMutation({ mutationFn: createOrder })
 *      → ts-morph resolves `createOrder` to its in-project
 *        declaration; the edge points at that declaration.
 *
 *   3. The new v5 single-arg form is the same as the object-options
 *      form above. The deprecated v4 positional form
 *      (`useMutation(createOrder, options)`) is also handled: the
 *      first positional arg, when it's not an object literal, is
 *      treated as the callback.
 *
 * Per-file gate: at least one import from a supported React Query
 * package, so we don't fire on a project-local function literally
 * named `useMutation` from another library.
 */

interface HookSpec {
  /** Property name to read from the options object for the callback. */
  readonly fnKey: 'mutationFn' | 'queryFn';
}

const HOOK_TO_FN_KEY: ReadonlyMap<string, HookSpec> = new Map([
  ['useMutation', { fnKey: 'mutationFn' }],
  ['useQuery', { fnKey: 'queryFn' }],
  ['useSuspenseQuery', { fnKey: 'queryFn' }],
  ['useInfiniteQuery', { fnKey: 'queryFn' }],
  ['useSuspenseInfiniteQuery', { fnKey: 'queryFn' }],
  // `useQueries` takes an array of queries — handled separately if/when needed.
]);

const SUPPORTED_IMPORT_PREFIXES = [
  '@tanstack/react-query',
  '@tanstack/react-query-experimental',
  '@tanstack/solid-query',
  '@tanstack/vue-query',
  '@tanstack/svelte-query',
  'react-query',
];

export function createReactQueryVisitor(): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();

  const fileImports = (node: Node): boolean => {
    const sf = node.getSourceFile();
    const filePath = sf.getFilePath();
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return SUPPORTED_IMPORT_PREFIXES.some((p) => spec === p || spec.startsWith(`${p}/`));
    });
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',

    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!fileImports(node)) return;

      const callee = node.getExpression();
      // Accept bare identifier (`useMutation(...)`) and namespaced
      // (`rq.useMutation(...)`) call shapes.
      let hookName: string | null = null;
      if (Node.isIdentifier(callee)) hookName = callee.getText();
      else if (Node.isPropertyAccessExpression(callee)) hookName = callee.getNameNode().getText();
      if (!hookName) return;

      const spec = HOOK_TO_FN_KEY.get(hookName);
      if (!spec) return;

      // React Query hooks must live inside a React component or custom
      // hook (a callable function). At module top level the hook would
      // throw at runtime, so we wouldn't see it in practice — but if
      // we ever do, skip emission rather than synthesize a `module`
      // FunctionDefinition that lang-ts never emitted (would leave a
      // dangling `functionId` reference).
      if (!ctx.enclosingFunction) return;
      const sourceLine = node.getStartLineNumber();
      const process: ClientSideProcess = {
        nodeType: 'ClientSideProcess',
        id: idFor.clientSideProcess({
          sourceFileId: ctx.sourceFile.id,
          sourceLine,
          name: hookName,
        }),
        // `lifecycle_hook` matches framework-vue's convention for
        // hooks invoked by the framework during a component's render
        // lifecycle. (`event_handler` is for direct response to user
        // gestures or reactive state changes.) React Query
        // useMutation / useQuery register a fetcher to be called by
        // the runtime, so lifecycle_hook is the right kind.
        kind: 'lifecycle_hook',
        name: hookName,
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine,
        framework: 'react-query',
        repository: ctx.sourceFile.repository,
        evidence: buildEvidence(node, ctx.sourceFile.filePath),
      };
      ctx.emitNode(process);

      // Locate the callback. Three shapes — see top-of-file comment.
      const args = node.getArguments();
      if (args.length === 0) return;
      const callback = locateCallback(args[0], args[1], spec.fnKey);
      if (!callback) return;

      const callbackId = resolveCallbackId(callback, ctx);
      if (!callbackId) return;

      ctx.emitEdge({
        edgeType: 'TRIGGERS',
        from: process.id,
        to: callbackId,
      });
    },
  };
}

/**
 * Find the callback expression among the hook's arguments. Returns
 * the inline function / identifier / call expression we treat as the
 * `mutationFn` / `queryFn` value, or null when nothing matches.
 *
 * Modern (v4+) single-arg options form:
 *     useMutation({ mutationFn: createOrder })
 * Deprecated v3 positional form:
 *     useMutation(createOrder, options)
 *     useQuery(['key'], queryFn)
 */
function locateCallback(
  firstArg: Node | undefined,
  secondArg: Node | undefined,
  fnKey: 'mutationFn' | 'queryFn',
): Expression | null {
  if (!firstArg) return null;
  if (Node.isObjectLiteralExpression(firstArg)) {
    return readObjectProperty(firstArg, fnKey);
  }
  // Positional fallback.
  if (fnKey === 'mutationFn') {
    if (isCallbackLike(firstArg)) return firstArg as Expression;
    return null;
  }
  // queryFn: first arg is the key, second is the fetcher.
  if (secondArg && isCallbackLike(secondArg)) return secondArg as Expression;
  // Or first arg is an options object with queryKey/queryFn already
  // handled above. Three-arg `useQuery(key, fetcher, options)` —
  // secondArg is fetcher, caught here.
  return null;
}

function readObjectProperty(obj: ObjectLiteralExpression, name: string): Expression | null {
  const prop = obj.getProperty(name);
  if (!prop) return null;
  if (Node.isPropertyAssignment(prop)) {
    const init = (prop as PropertyAssignment).getInitializer();
    return init ?? null;
  }
  if (Node.isShorthandPropertyAssignment(prop)) {
    // `{ mutationFn }` — the property name itself references an
    // identifier in scope. ts-morph models this name node as an
    // `Identifier`; `getSymbol()` on it returns the property's
    // synthetic symbol, but `getAliasedSymbol()` walks through to
    // the referenced value's symbol (which the downstream resolver
    // handles via the same alias-unwrap path used for imports).
    return prop.getNameNode() as unknown as Expression;
  }
  // MethodDeclaration: `{ mutationFn() { ... } }` shorthand. lang-ts
  // does NOT emit a FunctionDefinition for object-literal methods —
  // only for class methods — so we have no real target to point at.
  // Returning null leaves the process emitted but no TRIGGERS edge,
  // which matches the "degrade gracefully" policy for unresolvable
  // callbacks. A future enhancement could emit a synthetic
  // FunctionDefinition for the method body.
  return null;
}

function isCallbackLike(node: Node): boolean {
  return (
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isIdentifier(node) ||
    Node.isCallExpression(node) ||
    Node.isPropertyAccessExpression(node)
  );
}

/**
 * Compute the FunctionDefinition id the TRIGGERS edge should point
 * at. Delegates to `resolveFunctionDefinitionIdFromDecl`, the same
 * primitive lang-ts's structural walker, call resolver, Saga / RTK
 * thunk resolvers, and React-Native handler resolver use — single
 * source of truth (#263).
 *
 * Behaviour by callback shape:
 *
 *   - Arrow / function expression: lang-ts emits the arrow as a
 *     FunctionDefinition when its parent is one of the
 *     `inferCallbackName`-recognised contexts. For the React Query
 *     case the parent IS the `mutationFn:` / `queryFn:` property
 *     assignment, which Pattern 4 (object-literal property) handles.
 *     `resolveFunctionDefinitionIdFromDecl` computes the same name
 *     via `functionDefinitionName`, so the TRIGGERS edge points at
 *     the same node the structural walker emitted.
 *
 *   - Bare identifier: resolve via ts-morph's symbol service to the
 *     in-project declaration, then resolve to its FunctionDefinition
 *     id. Handles same-file and cross-file uniformly. Import-specifier
 *     aliases are followed via `getAliasedSymbol()` to the underlying
 *     declaration.
 *
 *   - Anything else (PropertyAccess, CallExpression returning a
 *     function, etc.) is currently unresolved.
 */
function resolveCallbackId(
  callback: Expression,
  ctx: TsVisitContext,
): string | null {
  if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
    return resolveFunctionDefinitionIdFromDecl(callback, ctx);
  }
  if (Node.isIdentifier(callback)) {
    const sym = callback.getSymbol();
    if (!sym) return null;
    // For a shorthand-property name (`{ mutationFn }`), the
    // identifier's symbol points at the property itself; the
    // referenced value's symbol lives behind the alias chain. Walk
    // one alias hop unconditionally, which is also what we want for
    // import specifiers (`import { createOrder } from './api'`).
    let target = sym;
    try {
      const aliased = sym.getAliasedSymbol();
      if (aliased) target = aliased;
    } catch {
      // ts-morph throws when the symbol has no alias — that's fine.
    }
    const declarations = target.getDeclarations();
    for (const decl of declarations) {
      const declFile = decl.getSourceFile().getFilePath();
      if (declFile.includes('node_modules')) continue;
      const id = resolveFunctionDefinitionIdFromDecl(decl, ctx);
      if (id) return id;
    }
    return null;
  }
  return null;
}
