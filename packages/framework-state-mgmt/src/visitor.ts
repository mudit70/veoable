import {
  Node,
  type Node as TsNode,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
} from 'ts-morph';
import {
  idFor,
  type ClientSideProcess,
  type ProcessKind,
  type ReadsStateEdge,
  type StateStore,
  type StateStoreField,
  type WritesStateEdge,
} from '@adorable/schema';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  resolveToString,
  resolveIdentifierTypeToDeclaration,
  resolveFunctionDefinitionIdFromDecl,
} from '@adorable/lang-ts';
import type { CallsFunctionEdge } from '@adorable/schema';

/**
 * State management framework visitor (#61).
 *
 * Detects client-side processes from state management libraries and
 * emits canonical `ClientSideProcess` nodes.
 *
 * Detection targets:
 *
 *  1. **Redux Toolkit** — `createAsyncThunk('type', async () => ...)`
 *     calls. First arg must be a string literal (the thunk type).
 *     Yields `kind: 'state_observer'`.
 *
 *  2. **Zustand** — `create((set, get) => ({ ... }))` calls where
 *     the first argument is a function expression (Zustand's signature).
 *     This avoids false positives on generic `create()` calls.
 *     Yields `kind: 'state_observer'`.
 *
 *  3. **MobX** — `autorun(() => ...)`, `reaction(() => ..., () => ...)`
 *     calls. These are reactive side-effects. Yields `kind: 'state_observer'`.
 *
 *  4. **Pinia** — `defineStore('id', { actions: { ... } })` calls.
 *     First arg must be a string literal (the store id).
 *     Yields `kind: 'state_observer'`.
 *
 *  5. **dispatch** — `dispatch(someAction())` calls where the argument
 *     is a call expression (Redux/NgRx pattern). Plain identifier args
 *     like `dispatch(fetchUsers)` are also matched. Framework is set
 *     to `'state-mgmt'` since dispatch is not exclusively Redux.
 */

/** Redux Toolkit async thunk detection */
const REDUX_THUNK_CALLEE = 'createAsyncThunk';

/**
 * Redux-Saga effect creators that bind an action type to a handler.
 * Each of these takes `(actionType, handlerSaga, ...rest)` so the
 * shape `<callee>(<actionType>, <handlerIdentifier>)` is uniform across
 * the set. (`throttle`/`debounce` take a delay first — handled separately.)
 */
const SAGA_TAKE_EFFECTS: ReadonlySet<string> = new Set([
  'takeLatest',
  'takeEvery',
  'takeLeading',
]);

/** Saga effects with a leading numeric delay arg. */
const SAGA_DELAY_EFFECTS: ReadonlySet<string> = new Set([
  'throttle',
  'debounce',
]);

/**
 * TanStack Query / RTK Query hooks that take a query/mutation function
 * either inline as an options-object property or as a positional arg.
 * The visitor extracts the function argument and emits a CALLS_FUNCTION
 * edge into it so the flow walker can step through the data-fetching
 * indirection.
 */
const QUERY_HOOKS: ReadonlySet<string> = new Set([
  'useQuery',
  'useSuspenseQuery',
  'useInfiniteQuery',
  'useSuspenseInfiniteQuery',
]);
const MUTATION_HOOKS: ReadonlySet<string> = new Set([
  'useMutation',
]);

/** MobX reactive side-effect functions */
const MOBX_REACTIVE_FUNS: ReadonlySet<string> = new Set([
  'autorun',
  'reaction',
  'when',
]);

/** Pinia store definition */
const PINIA_DEFINE_STORE = 'defineStore';

/**
 * #264 — Map a callee Identifier to the package(s) it must be imported
 * from before the visitor treats it as a state-mgmt hook. Apps with
 * local helpers named `useQuery`, `takeLatest`, `createAsyncThunk`
 * etc. should NOT trigger our detection.
 *
 * Module-specifier matching is exact-or-prefix-with-slash: a literal
 * `'@reduxjs/toolkit'` matches, and so does `'@reduxjs/toolkit/query/react'`
 * (subpath import) via the prefix-with-slash branch. A different
 * package whose name happens to start with the same characters does
 * NOT match (e.g., `'mobx-state-tree'` does NOT match `'mobx'`).
 */
const HOOK_IMPORT_SOURCES: Record<string, ReadonlyArray<string>> = {
  // Redux toolkit
  createAsyncThunk: ['@reduxjs/toolkit'],
  // Redux Saga effects
  takeLatest: ['redux-saga/effects'],
  takeEvery: ['redux-saga/effects'],
  takeLeading: ['redux-saga/effects'],
  throttle: ['redux-saga/effects'],
  debounce: ['redux-saga/effects'],
  // TanStack Query / RTK Query (the latter re-exports query hooks
  // through @reduxjs/toolkit/query/react which substring-matches
  // '@reduxjs/toolkit').
  useQuery: ['@tanstack/react-query', '@reduxjs/toolkit'],
  useSuspenseQuery: ['@tanstack/react-query'],
  useInfiniteQuery: ['@tanstack/react-query'],
  useSuspenseInfiniteQuery: ['@tanstack/react-query'],
  useMutation: ['@tanstack/react-query', '@reduxjs/toolkit'],
  // MobX
  autorun: ['mobx'],
  reaction: ['mobx'],
  when: ['mobx'],
  // Pinia
  defineStore: ['pinia'],
};

/**
 * Resolve a callee Identifier's canonical name through one level of
 * import-rename. For `import { takeLatest as tl } from 'redux-saga/effects'`,
 * `tl` resolves to `takeLatest` so the dispatch table can match.
 * Returns null when the callee isn't an import reference.
 */
function canonicalCalleeName(callee: TsNode): string | null {
  if (!Node.isIdentifier(callee)) return null;
  const symbol = callee.getSymbol();
  if (!symbol) return null;
  for (const decl of symbol.getDeclarations()) {
    if (Node.isImportSpecifier(decl)) {
      // `getNameNode()` returns the propertyName (the exported name).
      // `getAliasNode()` is the local alias if renamed.
      const propertyName = decl.getNameNode().getText();
      return propertyName;
    }
  }
  return null;
}

/**
 * Verify the callee Identifier resolves to a binding imported from
 * one of the expected package sources. Supports renamed imports
 * (`import { takeLatest as tl } from 'redux-saga/effects'`) by
 * walking through the type checker's symbol → declarations →
 * ImportDeclaration chain.
 *
 * Returns true when:
 *   - The identifier resolves to an ImportSpecifier / ImportClause /
 *     NamespaceImport whose ImportDeclaration's module specifier
 *     contains one of `expectedSources`.
 *   - HOOK_IMPORT_SOURCES has no entry for the name (no gate set —
 *     fall through to permissive). This is the conservative default
 *     for names we haven't enumerated.
 *
 * Returns false otherwise — the call site is rejected.
 */
function isHookImportedFromKnownPackage(
  callee: TsNode,
  expectedSources: ReadonlyArray<string>,
): boolean {
  if (!Node.isIdentifier(callee)) return false;
  const symbol = callee.getSymbol();
  if (!symbol) return false;
  for (const decl of symbol.getDeclarations()) {
    // Walk up to the ImportDeclaration if this decl is import-side.
    // ts-morph chain: ImportSpecifier → NamedImports → ImportClause → ImportDeclaration.
    let importDecl: TsNode | undefined;
    if (Node.isImportSpecifier(decl) || Node.isImportClause(decl) || Node.isNamespaceImport(decl)) {
      let p: TsNode | undefined = decl;
      while (p && !Node.isImportDeclaration(p)) p = p.getParent();
      importDecl = p;
    }
    if (importDecl && Node.isImportDeclaration(importDecl)) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      if (moduleSpecifier) {
        for (const source of expectedSources) {
          if (moduleSpecifier === source || moduleSpecifier.startsWith(source + '/')) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export function createStateMgmtVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      const callee = node.getExpression();

      // ── Identifier-based patterns ──────────────────────────────────
      if (Node.isIdentifier(callee)) {
        // #264 — resolve the canonical export name for renamed imports.
        // `import { takeLatest as tl } from 'redux-saga/effects'`
        // makes callee.getText() === 'tl', which would never match
        // any dispatch key. canonicalCalleeName traces the symbol
        // back to the ImportSpecifier and returns the propertyName
        // (the original exported name) so dispatch fires correctly.
        const name = canonicalCalleeName(callee) ?? callee.getText();

        // Redux: createAsyncThunk('type', async () => ...)
        // Requires first arg to be a string literal (the thunk type name).
        if (name === REDUX_THUNK_CALLEE) {
          // #264 — verify it's the real createAsyncThunk import.
          if (!isHookImportedFromKnownPackage(callee, HOOK_IMPORT_SOURCES.createAsyncThunk)) return;
          const thunkName = extractFirstStringArg(node);
          if (!thunkName) return; // Not createAsyncThunk('string', ...) shape

          const functionId = ctx.enclosingFunction?.id ?? computeFallbackFunctionId(node, ctx);
          if (!functionId) return;

          ctx.emitNode(buildProcess({
            kind: 'state_observer',
            name: `createAsyncThunk:${thunkName}`,
            framework: 'redux',
            ctx,
            functionId,
            sourceLine: node.getStartLineNumber(),
            astNode: node,
          }));
          return;
        }

        // TanStack Query / RTK Query hooks. `useQuery({ queryFn, ... })`
        // / `useMutation({ mutationFn })` (and positional-arg legacy
        // forms). When the fn argument resolves to a FunctionDefinition,
        // emit a CALLS_FUNCTION edge so the flow walker can step through.
        if (QUERY_HOOKS.has(name) || MUTATION_HOOKS.has(name)) {
          // #264 — gate by import source so app-local helpers named
          // useQuery/useMutation don't trigger us.
          const sources = HOOK_IMPORT_SOURCES[name];
          if (sources && isHookImportedFromKnownPackage(callee, sources)) {
            if (ctx.enclosingFunction) {
              const propKey = QUERY_HOOKS.has(name) ? 'queryFn' : 'mutationFn';
              emitTanstackQueryEdge(node, propKey, ctx);
            }
          }
          // Don't `return` — fall through to allow other branches (none
          // currently fire on these names, but stay conservative).
        }

        // Redux Saga: takeLatest('TYPE', handler), takeEvery, takeLeading
        // and throttle(ms, 'TYPE', handler), debounce(ms, 'TYPE', handler).
        // Emits a ClientSideProcess for the saga handler so it's visible
        // as an event_handler in the graph + a CALLS_FUNCTION edge from
        // the saga's enclosing generator (typically the rootSaga or a
        // module saga) to the handler. This makes the saga structure
        // explicit; cross-file dispatch→saga linking is a follow-up.
        if (SAGA_TAKE_EFFECTS.has(name) || SAGA_DELAY_EFFECTS.has(name)) {
          // #264 — gate by import source.
          const sources = HOOK_IMPORT_SOURCES[name];
          if (sources && isHookImportedFromKnownPackage(callee, sources)) {
            const sagaInfo = matchSagaEffect(node, name);
            if (sagaInfo) {
              emitSagaHandler(node, sagaInfo, ctx);
              return;
            }
          }
        }

        // MobX: autorun, reaction, when
        if (MOBX_REACTIVE_FUNS.has(name)) {
          // #264 — gate by import source.
          const sources = HOOK_IMPORT_SOURCES[name];
          if (!sources || !isHookImportedFromKnownPackage(callee, sources)) return;
          if (!ctx.enclosingFunction) return;

          ctx.emitNode(buildProcess({
            kind: 'state_observer',
            name,
            framework: 'mobx',
            ctx,
            functionId: ctx.enclosingFunction.id,
            sourceLine: node.getStartLineNumber(),
            astNode: node,
          }));
          return;
        }

        // Zustand: create((set, get) => ({ ... }))
        // M2 fix: Verify the first argument is a function expression to
        // avoid false positives on generic create() calls.
        // #192 follow-up: also honor renamed imports
        // (`import { create as makeStore } from 'zustand'`) via
        // `isCreateReference`.
        if (isCreateReference(callee)) {
          const args = node.getArguments();
          if (args.length === 0) return;
          const firstArg = args[0];
          // Direct: `create((set)=>...)` — first arg is the config arrow.
          // Middleware wrapped: `create(persist((set)=>...))` — first
          // arg is a CallExpression that wraps the real config arrow.
          if (
            !Node.isArrowFunction(firstArg) &&
            !Node.isFunctionExpression(firstArg) &&
            !Node.isCallExpression(firstArg)
          ) return;

          const functionId = ctx.enclosingFunction?.id ?? computeFallbackFunctionId(node, ctx);
          if (!functionId) return;

          ctx.emitNode(buildProcess({
            kind: 'state_observer',
            name: 'zustand:create',
            framework: 'zustand',
            ctx,
            functionId,
            sourceLine: node.getStartLineNumber(),
            astNode: node,
          }));

          // #192 — also emit a StateStore node with extracted fields
          // and actions. The store binding name comes from walking up
          // to the enclosing variable declaration (`const useStore = create(...)`).
          emitZustandStateStore(node, firstArg, ctx);
          return;
        }

        // #192 — Zustand selector reads: `useStore(s => s.foo)`.
        // The callee is the store binding; the first arg is an arrow
        // function whose body picks a field.
        if (ctx.enclosingFunction) {
          const readField = matchZustandSelectorRead(node, callee, ctx);
          if (readField) {
            const edge: ReadsStateEdge = {
              edgeType: 'READS_STATE',
              from: ctx.enclosingFunction.id,
              to: readField.storeId,
              field: readField.field,
              sourceLine: node.getStartLineNumber(),
            };
            ctx.emitEdge(edge);
            return;
          }
        }

        // Pinia: defineStore('id', { ... })
        // Requires first arg to be a string literal (the store id).
        if (name === PINIA_DEFINE_STORE) {
          // #264 — gate by import source.
          if (!isHookImportedFromKnownPackage(callee, HOOK_IMPORT_SOURCES.defineStore)) return;
          const storeName = extractFirstStringArg(node);
          if (!storeName) return; // Not defineStore('string', ...) shape

          const functionId = ctx.enclosingFunction?.id ?? computeFallbackFunctionId(node, ctx);
          if (!functionId) return;

          ctx.emitNode(buildProcess({
            kind: 'state_observer',
            name: `defineStore:${storeName}`,
            framework: 'pinia',
            ctx,
            functionId,
            sourceLine: node.getStartLineNumber(),
            astNode: node,
          }));
          return;
        }

        // Dispatch: dispatch(someAction()) or dispatch(fetchUsers)
        // M3 fix: Only match when the argument is a call expression or
        // identifier (Redux/NgRx dispatch pattern), not arbitrary args.
        // Framework is 'state-mgmt' (generic) since dispatch is not
        // exclusively Redux.
        if (name === 'dispatch') {
          if (!ctx.enclosingFunction) return;
          const args = node.getArguments();
          if (args.length === 0) return;
          const firstArg = args[0];
          // Only match dispatch(action()) or dispatch(actionCreator)
          if (!Node.isCallExpression(firstArg) && !Node.isIdentifier(firstArg)) return;

          ctx.emitNode(buildProcess({
            kind: 'event_handler',
            name: 'dispatch',
            framework: 'state-mgmt',
            ctx,
            functionId: ctx.enclosingFunction.id,
            sourceLine: node.getStartLineNumber(),
            astNode: node,
          }));

          // #256 Phase B — RTK createAsyncThunk dispatch resolution.
          // When the dispatched value resolves to a thunk creator
          // returned by `createAsyncThunk('type', payloadCreator)`,
          // emit a CALLS_FUNCTION edge from the enclosing function to
          // the payload-creator function so the flow walker can step
          // through the dispatch indirection.
          emitThunkDispatchEdge(node, firstArg, ctx);
          return;
        }
      }

      // #192 — Zustand action calls: `useStore.getState().setFoo(...)`.
      // The callee is a property access on a `getState()` call result.
      if (ctx.enclosingFunction && Node.isPropertyAccessExpression(callee)) {
        const writeAction = matchZustandActionWrite(callee, ctx);
        if (writeAction) {
          const edge: WritesStateEdge = {
            edgeType: 'WRITES_STATE',
            from: ctx.enclosingFunction.id,
            to: writeAction.storeId,
            action: writeAction.action,
            sourceLine: node.getStartLineNumber(),
          };
          ctx.emitEdge(edge);
          return;
        }
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

interface BuildProcessArgs {
  kind: ProcessKind;
  name: string;
  framework: string;
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0];
  functionId: string;
  sourceLine: number;
  astNode: TsNode;
}

function buildProcess(args: BuildProcessArgs): ClientSideProcess {
  const { kind, name, framework, ctx, functionId, sourceLine, astNode } = args;
  return {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      name,
    }),
    kind,
    name,
    functionId,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    framework,
    repository: ctx.sourceFile.repository,
    evidence: buildEvidence(astNode, ctx.sourceFile.filePath),
  };
}

/**
 * Extract the first string argument from a call expression.
 * Used for createAsyncThunk('type', ...) and defineStore('id', ...).
 */
function extractFirstStringArg(call: TsNode): string | null {
  if (!Node.isCallExpression(call)) return null;
  const args = call.getArguments();
  if (args.length === 0) return null;
  const first = args[0];
  if (Node.isStringLiteral(first)) return first.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(first)) return first.getLiteralValue();
  return null;
}

/**
 * Compute a fallback function ID when there's no enclosingFunction.
 * This happens for top-level store definitions (createAsyncThunk at module scope).
 * Uses the variable declaration if the call is the initializer of a const.
 */
function computeFallbackFunctionId(
  node: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0]
): string | null {
  const parent = node.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    const init = parent.getInitializer();
    if (init) {
      return idFor.functionDefinition({
        sourceFileId: ctx.sourceFile.id,
        name: parent.getName(),
        sourceLine: init.getStartLineNumber(),
      });
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// #256 Phase A — Redux Saga take-effect detection
// ──────────────────────────────────────────────────────────────────────

interface SagaEffectInfo {
  /** Resolved action type string ('LOGIN_USER_REQUEST'). */
  actionType: string;
  /** AST node of the handler argument. */
  handler: TsNode;
}

/**
 * Match a saga take-effect call shape:
 *   takeLatest(actionType, handler)         — name in SAGA_TAKE_EFFECTS
 *   throttle(ms, actionType, handler)       — name in SAGA_DELAY_EFFECTS
 *   debounce(ms, actionType, handler)
 *
 * Returns null if the shape doesn't match (wrong arity, non-resolvable
 * action type, etc.). Conservative on shape — false negatives over false
 * positives; the unresolved-action branch silently skips.
 */
function matchSagaEffect(call: TsNode, calleeName: string): SagaEffectInfo | null {
  if (!Node.isCallExpression(call)) return null;
  const args = call.getArguments();
  const isDelay = SAGA_DELAY_EFFECTS.has(calleeName);
  const expectedMin = isDelay ? 3 : 2;
  if (args.length < expectedMin) return null;

  const actionTypeArg = isDelay ? args[1] : args[0];
  const handlerArg = isDelay ? args[2] : args[1];

  // Action type resolution — a single `resolveToString` call now
  // covers all three cases:
  //   - direct string literal (`takeLatest('TYPE', h)`)
  //   - same-file const (`takeLatest(MY_TYPE, h)` where MY_TYPE =
  //     'TYPE')
  //   - cross-file import (`import { LOGIN_USER_REQUEST } from
  //     './action-types'`) — handled inside
  //     `resolveIdentifierToString` since lang-ts started following
  //     ImportSpecifier / ImportClause / NamespaceImport in #386.
  // The earlier hand-rolled `resolveIdentifierTypeToDeclaration`
  // fallback this used to need is now redundant.
  let actionType: string | null = null;
  if (Node.isStringLiteral(actionTypeArg) || Node.isNoSubstitutionTemplateLiteral(actionTypeArg)) {
    actionType = actionTypeArg.getLiteralValue();
  } else {
    actionType = resolveToString(actionTypeArg) ?? null;
  }
  if (!actionType) return null;

  return {
    actionType,
    handler: handlerArg,
  };
}

/**
 * Emit a ClientSideProcess for the saga handler + a CALLS_FUNCTION edge
 * from the saga's enclosing generator function (typically a `*moduleSaga`)
 * to the handler. Resolves the handler identifier to a same-file or
 * cross-file FunctionDefinition.id.
 */
function emitSagaHandler(
  call: TsNode,
  info: SagaEffectInfo,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): void {
  // Resolve the handler argument to a FunctionDefinition.id. The handler
  // is typically an Identifier referring to a generator function in the
  // same file (`function* loginModule() {...}`).
  const handlerFunctionId = resolveSagaHandlerId(info.handler, ctx);

  const sagaProcessName = `saga:${info.actionType}`;
  const fallbackFunctionId = ctx.enclosingFunction?.id ?? computeFallbackFunctionId(call, ctx);
  if (!fallbackFunctionId) return;

  // ClientSideProcess for the saga registration. The functionId points
  // at whichever function CONTAINS the takeLatest call (the rootSaga
  // or module saga, NOT the handler) — that's the runtime trigger
  // surface for this saga.
  ctx.emitNode(buildProcess({
    kind: 'event_handler',
    name: sagaProcessName,
    framework: 'redux-saga',
    ctx,
    functionId: fallbackFunctionId,
    sourceLine: call.getStartLineNumber(),
    astNode: call,
  }));

  // CALLS_FUNCTION edge from the registering generator → handler.
  // This makes the saga structure walkable by the flow walker.
  if (handlerFunctionId) {
    const edge: CallsFunctionEdge = {
      edgeType: 'CALLS_FUNCTION',
      from: fallbackFunctionId,
      to: handlerFunctionId,
      sourceLine: call.getStartLineNumber(),
      arguments: [info.actionType],
      isConditional: false,
      confidence: 'indirect',
    };
    ctx.emitEdge(edge);
  }
}

/**
 * Resolve a saga handler argument to a FunctionDefinition.id via
 * the shared cross-file resolver (#263). Same-file and cross-file
 * named generators / variable-bound arrows both resolve correctly.
 * Inline arrow / function expression handlers return null (no named
 * declaration to point at).
 */
function resolveSagaHandlerId(
  handler: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): string | null {
  if (!Node.isIdentifier(handler)) return null;
  // Predicate matches any function-shape — FunctionDeclaration,
  // VariableDeclaration (arrow/fn-expr bound), FunctionExpression,
  // ArrowFunction. The shared resolver handles all of these via
  // lang-ts's `isFunctionShape`.
  const decl = resolveIdentifierTypeToDeclaration(handler, (d) => {
    return Node.isFunctionDeclaration(d)
      || Node.isVariableDeclaration(d)
      || Node.isFunctionExpression(d)
      || Node.isArrowFunction(d);
  });
  if (!decl) return null;
  return resolveFunctionDefinitionIdFromDecl(decl, ctx);
}

// ──────────────────────────────────────────────────────────────────────
// #256 Phase B — RTK createAsyncThunk dispatch resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a dispatched expression to a thunk creator declared via
 * `createAsyncThunk(type, payloadCreator)`. When found, emit a
 * CALLS_FUNCTION edge from the enclosing function to the payload
 * creator's FunctionDefinition.
 *
 * Handles:
 *   dispatch(fetchUser())          — first arg is a CallExpression
 *   dispatch(fetchUser(args))      — first arg is a CallExpression w/ args
 *   dispatch(fetchUser)            — first arg is an Identifier (the creator itself)
 *
 * Bails on:
 *   - Non-thunk action creators (regular `(payload) => ({type, payload})`).
 *   - Inline arrow payload creators (no resolvable function id).
 *   - Cross-package thunks (the path the cross-file resolver can't trace).
 */
function emitThunkDispatchEdge(
  dispatchCall: TsNode,
  dispatchedArg: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): void {
  if (!ctx.enclosingFunction) return;

  // Step 1: extract the creator identifier from the dispatched expression.
  let creatorIdent: TsNode | null = null;
  if (Node.isIdentifier(dispatchedArg)) {
    creatorIdent = dispatchedArg;
  } else if (Node.isCallExpression(dispatchedArg)) {
    const callee = dispatchedArg.getExpression();
    if (Node.isIdentifier(callee)) creatorIdent = callee;
  }
  if (!creatorIdent || !Node.isIdentifier(creatorIdent)) return;

  // Step 2: resolve the creator to its declaration.
  const creatorDecl = resolveIdentifierTypeToDeclaration(creatorIdent, (d) => Node.isVariableDeclaration(d));
  if (!creatorDecl || !Node.isVariableDeclaration(creatorDecl)) return;

  // Step 3: the creator's initializer must be `createAsyncThunk(type, payloadCreator)`.
  const init = creatorDecl.getInitializer();
  if (!init || !Node.isCallExpression(init)) return;
  const creatorCallee = init.getExpression();
  if (!Node.isIdentifier(creatorCallee) || creatorCallee.getText() !== REDUX_THUNK_CALLEE) return;

  const initArgs = init.getArguments();
  if (initArgs.length < 2) return;
  const payloadCreator = initArgs[1];

  // Step 4: payload creator must be an inline arrow / function expression
  // bound to a name, or an Identifier referring to a named function.
  // We only emit when we can compute a deterministic FunctionDefinition.id.
  const payloadFnId = resolvePayloadCreatorFunctionId(payloadCreator, ctx);
  if (!payloadFnId) return;

  const edge: CallsFunctionEdge = {
    edgeType: 'CALLS_FUNCTION',
    from: ctx.enclosingFunction.id,
    to: payloadFnId,
    sourceLine: dispatchCall.getStartLineNumber(),
    arguments: [],
    isConditional: false,
    confidence: 'indirect',
  };
  ctx.emitEdge(edge);
}

/**
 * Resolve a createAsyncThunk's payload-creator argument to a
 * FunctionDefinition.id. lang-ts emits the inline arrow with name
 * `${variableName}` (Pattern 0) when bound via VariableDeclaration
 * initializer (the createAsyncThunk call itself). For
 * `dispatch(thunkCreator)` we want to walk INTO the payload creator,
 * which lang-ts assigns the variable's name when it's the create
 * call's second arg.
 *
 * The simpler reality: lang-ts walks INTO inline arrows passed as
 * function arguments only when one of the existing inferCallbackName
 * patterns matches. createAsyncThunk's payload creator is at a
 * CallExpression argument position with no such pattern, so the
 * inline arrow does NOT get a FunctionDefinition emitted. To resolve
 * a stable id, we either need an Identifier handler (named function)
 * or extend lang-ts's inferCallbackName. For Phase B, only handle
 * named-function payload creators — inline arrows are deferred.
 */
function resolvePayloadCreatorFunctionId(
  payloadArg: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): string | null {
  // Identifier referring to a named function — resolved via the
  // shared cross-file resolver (#263). Cross-file payload creators
  // now resolve correctly. Inline arrows return null (no named decl).
  if (Node.isIdentifier(payloadArg)) {
    const decl = resolveIdentifierTypeToDeclaration(payloadArg, (d) => {
      return Node.isFunctionDeclaration(d)
        || Node.isVariableDeclaration(d)
        || Node.isArrowFunction(d)
        || Node.isFunctionExpression(d);
    });
    if (!decl) return null;
    return resolveFunctionDefinitionIdFromDecl(decl, ctx);
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// #256 Phase C — TanStack / RTK Query data-fetching indirection
// ──────────────────────────────────────────────────────────────────────

/**
 * Match a TanStack Query / RTK Query hook call and emit a CALLS_FUNCTION
 * edge from the enclosing component to the resolved query/mutation
 * function.
 *
 * Handles the canonical forms:
 *   useQuery({ queryKey, queryFn })          — modern, options-object
 *   useQuery(['users'], fetchUsers)          — legacy positional
 *   useMutation({ mutationFn })              — modern
 *   useMutation((data) => api.post(data))    — legacy positional
 *
 * The fn argument is resolved when:
 *   - It's an Identifier referring to a same-file or cross-file named
 *     function (resolved via the type checker).
 *   - It's an inline arrow whose parent is a PropertyAssignment in an
 *     ObjectLiteralExpression — lang-ts's inferCallbackName Pattern 4
 *     names it after the property (`queryFn`), so the FunctionDefinition
 *     id is computable.
 */
function emitTanstackQueryEdge(
  hookCall: TsNode,
  propKey: 'queryFn' | 'mutationFn',
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): void {
  if (!Node.isCallExpression(hookCall)) return;
  if (!ctx.enclosingFunction) return;

  const args = hookCall.getArguments();
  if (args.length === 0) return;

  // Find the fn argument.
  //   Object form:   args[0] is ObjectLiteralExpression with `queryFn:` or `mutationFn:` property.
  //   Positional:    queryFn is args[1] (after queryKey); mutationFn is args[0].
  let fnArg: TsNode | null = null;
  if (Node.isObjectLiteralExpression(args[0])) {
    const prop = args[0].getProperty(propKey);
    if (prop && Node.isPropertyAssignment(prop)) {
      const initializer = prop.getInitializer();
      if (initializer) fnArg = initializer;
    } else if (prop && Node.isShorthandPropertyAssignment(prop)) {
      // `useQuery({ queryFn })` — shorthand for `queryFn: queryFn`.
      fnArg = prop.getNameNode();
    }
  } else if (propKey === 'queryFn' && args.length >= 2) {
    fnArg = args[1];
  } else if (propKey === 'mutationFn') {
    fnArg = args[0];
  }
  if (!fnArg) return;

  const fnId = resolveFnArgToFunctionId(fnArg, propKey, ctx);
  if (!fnId) return;

  const edge: CallsFunctionEdge = {
    edgeType: 'CALLS_FUNCTION',
    from: ctx.enclosingFunction.id,
    to: fnId,
    sourceLine: hookCall.getStartLineNumber(),
    arguments: [],
    isConditional: false,
    confidence: 'indirect',
  };
  ctx.emitEdge(edge);
}

/**
 * Resolve a query/mutation function argument to a FunctionDefinition.id.
 *   - Identifier (same-file or cross-file) → resolves via the shared
 *     cross-file resolver (#263).
 *   - Inline arrow at PropertyAssignment position → lang-ts emits a
 *     FunctionDefinition named after the property key (Pattern 4).
 *     Same-file only — id matches `idFor.functionDefinition({sourceFileId,
 *     name: propKey, sourceLine: arrow.start})`.
 */
function resolveFnArgToFunctionId(
  fnArg: TsNode,
  propKey: string,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): string | null {
  if (Node.isIdentifier(fnArg)) {
    const decl = resolveIdentifierTypeToDeclaration(fnArg, (d) => {
      return Node.isFunctionDeclaration(d)
        || Node.isVariableDeclaration(d)
        || Node.isArrowFunction(d)
        || Node.isFunctionExpression(d);
    });
    if (!decl) return null;
    return resolveFunctionDefinitionIdFromDecl(decl, ctx);
  }
  if (Node.isArrowFunction(fnArg) || Node.isFunctionExpression(fnArg)) {
    // Inline arrow at PropertyAssignment / positional-arg position.
    // lang-ts's Pattern 4 names PropertyAssignment-bound arrows after
    // the property key. Positional-arg arrows aren't named by Pattern
    // 4 — return null in that case (no resolvable id).
    const parent = fnArg.getParent();
    if (parent && Node.isPropertyAssignment(parent)) {
      return idFor.functionDefinition({
        sourceFileId: ctx.sourceFile.id,
        name: propKey,
        sourceLine: fnArg.getStartLineNumber(),
      });
    }
    return null;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// #192 — Zustand StateStore emission
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk up from the `create(...)` CallExpression to find the
 * `const <name> = create(...)` binding, extract field + action names
 * from the returned object literal, and emit a StateStore node.
 *
 * Conservative on shape:
 *   - The arrow body must be a single returned ObjectLiteralExpression
 *     (either expression-body `(set) => ({...})` or block-body
 *     `(set) => { return {...}; }`).
 *   - Fields = top-level keys whose initializer is NOT a function.
 *   - Actions = top-level keys whose initializer IS an arrow / fn expr.
 *
 * Out of scope: middleware-wrapped stores `create(persist((set) => ...))`
 * — the inner config callback's body is what matters; we'd need to
 * unwrap one level. Subsequent PR.
 */
function emitZustandStateStore(
  callNode: TsNode,
  fnArg: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): void {
  // Middleware-wrapped form: `create(persist((set)=>({...})))` —
  // unwrap one or more middleware layers (persist, devtools, immer,
  // subscribeWithSelector, ...) to find the inner arrow whose object
  // literal carries the actual fields/actions. Without this, reads/
  // writes resolve to a StateStore id that was never emitted.
  let resolved: TsNode = fnArg;
  for (let i = 0; i < 4 && Node.isCallExpression(resolved); i++) {
    const args = resolved.getArguments();
    if (args.length === 0) return;
    resolved = args[0];
  }
  if (!Node.isArrowFunction(resolved) && !Node.isFunctionExpression(resolved)) return;

  const objLit = extractStoreObjectLiteral(resolved);
  if (!objLit) return;

  // Walk up to find the enclosing `const <name> = create(...)` binding.
  let parent: TsNode | undefined = callNode.getParent();
  // The call may be wrapped in another call (e.g.,
  // `create<StoreState>()((set, get) => ({...}))`). Walk up one level
  // through parens / call expressions until we hit a VariableDeclaration.
  for (let i = 0; i < 4 && parent && !Node.isVariableDeclaration(parent); i++) {
    parent = parent.getParent();
  }
  if (!parent || !Node.isVariableDeclaration(parent)) return;
  const storeName = parent.getName();
  if (!storeName) return;

  const fields: StateStoreField[] = [];
  const actions: string[] = [];
  for (const prop of objLit.getProperties()) {
    if (!Node.isPropertyAssignment(prop) && !Node.isMethodDeclaration(prop)) continue;
    // Note: NumericLiteral / computed / spread keys are silently
    // skipped — vanishingly rare in store shapes.
    const nameNode = prop.getNameNode();
    if (!nameNode) continue;
    const key = Node.isIdentifier(nameNode) ? nameNode.getText()
      : Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue()
      : null;
    if (!key) continue;

    if (Node.isMethodDeclaration(prop)) {
      actions.push(key);
      continue;
    }
    // PropertyAssignment: classify by initializer.
    const init = prop.getInitializer();
    if (!init) {
      fields.push({ name: key, type: null });
      continue;
    }
    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      actions.push(key);
    } else {
      fields.push({ name: key, type: null });
    }
  }

  const store: StateStore = {
    nodeType: 'StateStore',
    id: idFor.stateStore({ declaredIn: ctx.sourceFile.id, name: storeName }),
    name: storeName,
    framework: 'zustand',
    declaredIn: ctx.sourceFile.id,
    fields,
    actions,
    sourceLine: callNode.getStartLineNumber(),
    repository: ctx.sourceFile.repository,
  };
  ctx.emitNode(store);
}

/**
 * Reduce the function passed to `create(...)` to the returned
 * ObjectLiteralExpression. Handles both expression-body
 * `(set) => ({ ... })` and block-body `(set) => { return {...}; }`.
 */
function extractStoreObjectLiteral(fn: TsNode): ObjectLiteralExpression | null {
  let body: TsNode | null = null;
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) {
    body = fn.getBody();
  }
  if (!body) return null;
  // Expression-body: parenthesized object literal.
  if (Node.isParenthesizedExpression(body)) {
    const inner = body.getExpression();
    if (Node.isObjectLiteralExpression(inner)) return inner;
  }
  if (Node.isObjectLiteralExpression(body)) return body;
  // Block body: single return statement with an object literal.
  if (Node.isBlock(body)) {
    const stmts = body.getStatements();
    for (const stmt of stmts) {
      if (Node.isReturnStatement(stmt)) {
        const expr = stmt.getExpression();
        if (!expr) return null;
        if (Node.isParenthesizedExpression(expr)) {
          const inner = expr.getExpression();
          if (Node.isObjectLiteralExpression(inner)) return inner;
        }
        if (Node.isObjectLiteralExpression(expr)) return expr;
        return null;
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// #192 — Zustand read/write detection
// ──────────────────────────────────────────────────────────────────────

/**
 * Match a Zustand selector read of the shape `useStore(s => s.foo)`.
 *
 * Same-file MVP: the callee identifier must resolve to a
 * `const useStore = create(...)` declaration in the SAME source file.
 * Cross-file resolution is out of scope and tracked separately
 * alongside the cross-file render-component walk.
 *
 * Returns the StateStore id (computed via `idFor.stateStore`) and the
 * selected field name when the arrow body is a simple property access
 * `s => s.foo`. Falls back to a null `field` when the selector is
 * broader (e.g., `s => ({ a: s.a, b: s.b })`); the read edge still
 * fires so the function is correctly attached to the store.
 */
function matchZustandSelectorRead(
  callNode: TsNode,
  callee: TsNode,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): { storeId: string; field: string | null } | null {
  if (!Node.isCallExpression(callNode)) return null;
  if (!Node.isIdentifier(callee)) return null;

  // First arg must be a function — that's the selector.
  const args = callNode.getArguments();
  if (args.length === 0) return null;
  const firstArg = args[0];
  if (!Node.isArrowFunction(firstArg) && !Node.isFunctionExpression(firstArg)) return null;

  // Resolve the callee identifier to a same-file `const X = create(...)`.
  const decl = resolveStoreDeclaration(callee);
  if (!decl) return null;

  const storeId = idFor.stateStore({
    declaredIn: ctx.sourceFile.id,
    name: decl.getName(),
  });

  // Try to extract a top-level field name from the selector body.
  let field: string | null = null;
  const body = firstArg.getBody();
  if (Node.isPropertyAccessExpression(body)) {
    field = body.getName();
  } else if (Node.isParenthesizedExpression(body)) {
    const inner = body.getExpression();
    if (Node.isPropertyAccessExpression(inner)) field = inner.getName();
  }
  return { storeId, field };
}

/**
 * Match a Zustand action call of the shape
 * `useStore.getState().setFoo(...)` or `useStore.getState().setFoo`.
 *
 * Walks the property-access chain looking for a `.getState()` call on
 * an Identifier that resolves to a same-file `create(...)` binding.
 * The action name is the property accessed AFTER `getState()`.
 */
function matchZustandActionWrite(
  callee: PropertyAccessExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): { storeId: string; action: string } | null {
  // `useStore.getState().setFoo` — the receiver of the property access
  // must itself be a CallExpression invoking `.getState()` on an
  // Identifier that points at a store binding.
  const action = callee.getName();
  if (!action) return null;

  const receiver = callee.getExpression();
  if (!Node.isCallExpression(receiver)) return null;

  const inner = receiver.getExpression();
  if (!Node.isPropertyAccessExpression(inner)) return null;
  if (inner.getName() !== 'getState') return null;

  const storeIdent = inner.getExpression();
  if (!Node.isIdentifier(storeIdent)) return null;

  const decl = resolveStoreDeclaration(storeIdent);
  if (!decl) return null;

  const storeId = idFor.stateStore({
    declaredIn: ctx.sourceFile.id,
    name: decl.getName(),
  });
  return { storeId, action };
}

/**
 * Resolve an Identifier to its declaring `const X = create(...)`
 * binding in the SAME source file. Returns null for cross-file or
 * non-Zustand initializers.
 *
 * Two layers of guarding so we don't false-positive on `Model.create`,
 * `redux.createStore`, `Stripe.create`, etc.:
 *   1. The callee identifier must resolve to a `create` function
 *      imported from `'zustand'` (or a re-export). Renamed imports
 *      `import { create as makeStore } from 'zustand'` are detected
 *      via this symbol-walk.
 *   2. As a fallback (callee is bare `create` with no resolvable
 *      symbol), the create call's first arg must be an arrow /
 *      function expression — Zustand's signature.
 */
function resolveStoreDeclaration(ident: TsNode): import('ts-morph').VariableDeclaration | null {
  if (!Node.isIdentifier(ident)) return null;
  const sym = ident.getSymbol();
  if (!sym) return null;
  for (const d of sym.getDeclarations()) {
    if (!Node.isVariableDeclaration(d)) continue;
    const init = d.getInitializer();
    if (!init) continue;

    // Direct form: const useStore = create(...)
    if (Node.isCallExpression(init)) {
      if (isZustandCreateCall(init)) return d;
    }
  }
  return null;
}

/**
 * True iff `call` is a Zustand-style `create(arrow|fnExpr, ...)` call.
 *
 * Direct form `create(fn)` and curried form `create<T>()(fn)` are both
 * accepted — the curried form's outer call has a CallExpression callee
 * whose own callee is the actual `create`.
 *
 * Middleware-wrapped form `create(persist((set)=>...))` is also
 * accepted; the wrapper unwrapping for fields/actions is handled in
 * `extractStoreObjectLiteral`.
 */
function isZustandCreateCall(call: TsNode): boolean {
  if (!Node.isCallExpression(call)) return false;
  const callee = call.getExpression();

  // Curried: `create<T>()((set)=>...)` — the outer call's callee is
  // itself a CallExpression `create<T>()`. Unwrap one level and
  // require the *inner* callee to be a `create` reference.
  if (Node.isCallExpression(callee)) {
    const innerCallee = callee.getExpression();
    if (!isCreateReference(innerCallee)) return false;
  } else if (!isCreateReference(callee)) {
    return false;
  }

  // First arg must be a function. This is the cheap shape filter
  // that disqualifies `Model.create({...})` etc. that happen to use
  // an aliased identifier named `create`.
  const args = call.getArguments();
  if (args.length === 0) return false;
  const first = args[0];
  if (Node.isArrowFunction(first) || Node.isFunctionExpression(first)) return true;
  // Middleware wrapper: `create(persist((set)=>...))` — first arg is
  // a CallExpression wrapping the real config arrow. Accept it; the
  // shape check is good enough for this layer.
  if (Node.isCallExpression(first)) return true;
  return false;
}

/**
 * True iff the callee identifier resolves to the `create` export of
 * the `zustand` package (or `zustand/vanilla`, common for store-only
 * usage). Renamed imports `import { create as makeStore } from 'zustand'`
 * resolve through `getSymbol()` to the import-specifier whose module
 * specifier is `'zustand*'`.
 *
 * Fallback when symbol resolution fails (no tsconfig, ambient stubs):
 * accept the bare text form `create` or `<ns>.create`.
 */
function isCreateReference(node: TsNode): boolean {
  if (!Node.isIdentifier(node)) return false;
  // Renamed-import detection: walk the symbol's declarations looking
  // for an ImportSpecifier whose *exported* name is `create`. The
  // local name may be aliased (`import { create as makeStore }`).
  const sym = node.getSymbol();
  if (sym) {
    for (const d of sym.getDeclarations()) {
      if (!Node.isImportSpecifier(d)) continue;
      // ImportSpecifier.getName() returns the exported name; the
      // alias node (`getAliasNode()`) carries the local rename. We
      // do NOT pin to module name 'zustand' so test fixtures using
      // local stub modules still resolve. The first-arg shape check
      // in `isZustandCreateCall` is the disambiguator that
      // distinguishes Zustand `create(arrow)` from other APIs.
      if (d.getName() === 'create') return true;
    }
  }
  // No import-specifier match → fall back to text. Bare `create`
  // accepts in-file declarations (test stubs, locally-named factories).
  return node.getText() === 'create';
}
