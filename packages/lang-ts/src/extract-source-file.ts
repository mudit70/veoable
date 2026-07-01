import * as path from 'node:path';
import { Node, SyntaxKind, type SourceFile as TsSourceFile } from 'ts-morph';
import {
  idFor,
  type SchemaEdge,
  type SchemaNode,
  type SourceFile as SchemaSourceFile,
  type FunctionDefinition,
  type EnvironmentVariable,
  type EnvVarCategory,
  type Parameter,
  type RequestField,
  type ResponseShape,
} from '@adorable/schema';
import { extractCalls, findDynamicImports } from './extract-calls.js';
import type { TsProjectInternal } from './project-handle.js';
import type { TsFrameworkVisitor, TsVisitContext } from './framework-visitor.js';
import { buildEvidence } from './evidence.js';

/**
 * Result of walking a single source file. Returned to the caller
 * (`TsLanguagePlugin.extractFile`) which folds it into the outgoing
 * `NodeBatch`.
 */
export interface FileExtractionResult {
  nodes: SchemaNode[];
  edges: SchemaEdge[];
}

/**
 * Walk one source file and emit:
 *  - 1 SourceFile node
 *  - N FunctionDefinition nodes
 *  - DEFINED_IN edges (FunctionDefinition → SourceFile)
 *  - EXPORTS edges (SourceFile → FunctionDefinition)
 *  - IMPORTS edges (SourceFile → SourceFile) for resolved cross-file imports
 *
 * No call graph in this PR — `CALLS_FUNCTION` lands in PR 2.
 *
 * The walk is structural only: it does not invoke framework visitors
 * (PR 3) and does not do any semantic resolution beyond what ts-morph's
 * `getModuleSpecifierSourceFile` gives us for free during import
 * resolution.
 */
export function extractSourceFile(
  internal: TsProjectInternal,
  file: TsSourceFile,
  visitors: readonly TsFrameworkVisitor[] = []
): FileExtractionResult {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];

  // ── SourceFile node ───────────────────────────────────────────────
  const sourceFile = buildSourceFileNode(internal, file);
  nodes.push(sourceFile);

  // ── Single walk: FunctionDefinition + DEFINED_IN + visitor dispatch ──
  // The walker visits every AST node recursively. When it encounters a
  // function-shaped node it emits the corresponding FunctionDefinition
  // and DEFINED_IN edge, and pushes it onto a stack so downstream
  // visitor dispatches for nodes inside the function see the correct
  // `enclosingFunction`. Framework visitors registered via
  // `registerVisitor` are invoked once per node during this walk.
  const fnByDeclaration = new Map<Node, FunctionDefinition>();
  // The visitCtx is intentionally allocated ONCE per file and mutated
  // in place by `walkForExtraction` before each visitor dispatch. This
  // is a hot-path optimization: a real project dispatches `onNode`
  // tens of thousands of times per file, and allocating a fresh
  // context object per dispatch shows up in flame graphs. Visitors are
  // documented (see `TsVisitContext` JSDoc) to NOT retain the ctx
  // reference past the synchronous return of `onNode`.
  const visitCtx: TsVisitContext = {
    sourceFile,
    enclosingFunction: undefined,
    project: internal.project,
    rootDir: internal.rootDir,
    repository: internal.repository,
    emitNode: (n) => nodes.push(n),
    emitEdge: (e) => edges.push(e),
  };
  const functionStack: FunctionDefinition[] = [];

  walkForExtraction(file, {
    sourceFileId: sourceFile.id,
    filePath: sourceFile.filePath,
    fnByDeclaration,
    nodes,
    edges,
    functionStack,
    visitors,
    visitCtx,
  });

  // ── EXPORTS edges ─────────────────────────────────────────────────
  for (const [decl, fnDef] of fnByDeclaration) {
    if (!fnDef.isExported) continue;
    const exportName = exportNameFor(decl, fnDef.name);
    if (exportName === null) continue;
    edges.push({
      edgeType: 'EXPORTS',
      from: sourceFile.id,
      to: fnDef.id,
      exportName,
      isDefault: isDefaultExport(decl),
    });
  }

  // ── IMPORTS edges ─────────────────────────────────────────────────
  for (const importDecl of file.getImportDeclarations()) {
    const targetFile = importDecl.getModuleSpecifierSourceFile();
    if (!targetFile) {
      // External (node_modules) or unresolved — out of scope for the
      // call graph since we can't reach into external code.
      continue;
    }

    const symbols: string[] = [];
    let isDefault = false;

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
      symbols.push(defaultImport.getText());
      isDefault = true;
    }
    for (const named of importDecl.getNamedImports()) {
      symbols.push(named.getName());
    }
    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) {
      symbols.push(`* as ${namespaceImport.getText()}`);
    }

    edges.push({
      edgeType: 'IMPORTS',
      from: sourceFile.id,
      to: idFor.sourceFile({
        repository: internal.repository,
        filePath: relativePath(internal.rootDir, targetFile.getFilePath()),
      }),
      symbols,
      isDefault,
      // Static `import` declarations only at this layer. Dynamic
      // `import()` calls are handled in PR 2 with the call graph.
      isDynamic: false,
    });
  }

  // ── Re-export IMPORTS edges ───────────────────────────────────────
  // `export { foo } from './bar.js'` and `export * from './bar.js'`
  // also create a cross-file dependency at the module graph level, so
  // we emit them as IMPORTS edges too. The symbols are the re-exported
  // names (or `* as Name` for a namespace re-export, or `*` for a bare
  // `export *`). They are NOT marked `isDefault` unless the re-export
  // explicitly re-exports the default binding.
  for (const exportDecl of file.getExportDeclarations()) {
    const targetFile = exportDecl.getModuleSpecifierSourceFile();
    if (!targetFile) continue; // plain `export { foo }` with no source — not a re-export
    const symbols: string[] = [];
    let isDefault = false;
    const namespaceExport = exportDecl.getNamespaceExport();
    if (namespaceExport) {
      symbols.push(`* as ${namespaceExport.getName()}`);
    }
    const named = exportDecl.getNamedExports();
    if (named.length === 0 && !namespaceExport) {
      symbols.push('*');
    }
    for (const n of named) {
      const name = n.getName();
      if (name === 'default') isDefault = true;
      symbols.push(name);
    }
    edges.push({
      edgeType: 'IMPORTS',
      from: sourceFile.id,
      to: idFor.sourceFile({
        repository: internal.repository,
        filePath: relativePath(internal.rootDir, targetFile.getFilePath()),
      }),
      symbols,
      isDefault,
      isDynamic: false,
    });
  }

  // ── Dynamic imports → IMPORTS edges with isDynamic: true ─────────
  // `import('./foo.js')` is a CallExpression in the AST but it
  // expresses a module dependency, not a function call. Emit it as
  // an IMPORTS edge so the import graph is complete.
  for (const dynamicImport of findDynamicImports(file)) {
    const args = dynamicImport.getArguments();
    if (args.length !== 1) continue;
    const arg = args[0];
    if (!Node.isStringLiteral(arg)) {
      // Computed module specifier — we cannot resolve it statically.
      continue;
    }
    const specifier = arg.getLiteralValue();
    const targetFile = resolveDynamicImportTarget(internal, file, specifier);
    if (!targetFile) continue;
    edges.push({
      edgeType: 'IMPORTS',
      from: sourceFile.id,
      to: idFor.sourceFile({
        repository: internal.repository,
        filePath: relativePath(internal.rootDir, targetFile),
      }),
      symbols: [],
      isDefault: false,
      isDynamic: true,
    });
  }

  // ── CALLS_FUNCTION edges ──────────────────────────────────────────
  const callResult = extractCalls(internal, file, { fnByDeclaration });
  edges.push(...callResult.edges);

  return { nodes, edges };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function buildSourceFileNode(internal: TsProjectInternal, file: TsSourceFile): SchemaSourceFile {
  const filePath = relativePath(internal.rootDir, file.getFilePath());
  return {
    nodeType: 'SourceFile',
    id: idFor.sourceFile({ repository: internal.repository, filePath }),
    filePath,
    repository: internal.repository,
    language: 'ts',
    framework: null,
  };
}

interface WalkState {
  sourceFileId: string;
  filePath: string;
  fnByDeclaration: Map<Node, FunctionDefinition>;
  nodes: SchemaNode[];
  edges: SchemaEdge[];
  functionStack: FunctionDefinition[];
  visitors: readonly TsFrameworkVisitor[];
  visitCtx: TsVisitContext;
}

/**
 * Walk every AST node in the file, recursively. For each node we do
 * three things in order:
 *
 *   1. Identify whether the node is function-shaped. If so, build the
 *      `FunctionDefinition`, push it onto `functionStack`, and emit
 *      the corresponding `DEFINED_IN` edge.
 *   2. Dispatch every registered framework visitor's `onNode` with
 *      the current `enclosingFunction` (stack top, undefined at
 *      module level). The visitor sees function-shape nodes with
 *      their *outer* function as the enclosing context, because the
 *      push happens before children are walked but AFTER we set up
 *      the context for the function-shape node itself. This matches
 *      the intuition that the function declaration statement lives
 *      in its parent scope.
 *   3. Recurse into children.
 *   4. If a function was pushed for this node, pop it.
 *
 * This is a single pass over the AST that replaces the previous
 * two-pass structure (walker + extractCalls did two descents).
 * `extractCalls` still does its own `getDescendantsOfKind` scan; see
 * PR 3's follow-up note for why that's kept separate for now.
 */
function walkForExtraction(node: Node, state: WalkState): void {
  let pushed: FunctionDefinition | undefined;

  // ── 1. Identify function-shaped node ───────────────────────────
  if (Node.isFunctionDeclaration(node)) {
    const name = node.getName() ?? '<anonymous>';
    const isExported = node.isExported() || node.isDefaultExport();
    pushed = recordFunction(state, node, name, isExported);
  } else if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      const variableStatement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      const isExported =
        !!variableStatement && (variableStatement.isExported() || variableStatement.isDefaultExport());
      pushed = recordFunction(state, initializer, node.getName(), isExported);
    }
  } else if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    // Inline callbacks in JSX attributes and lifecycle hooks.
    // Variable-bound arrows are handled above via VariableDeclaration.
    // Skip if already handled (parent is a VariableDeclaration).
    const parent = node.getParent();
    if (parent && !Node.isVariableDeclaration(parent)) {
      const callbackName = inferCallbackName(node, state);
      if (callbackName) {
        pushed = recordFunction(state, node, callbackName, false);
        // Emit a CALLS_FUNCTION edge from the enclosing function to the
        // inline callback so the BFS call graph can reach the callback's
        // body. This is semantically "the component sets up this callback".
        const enclosing = state.functionStack[state.functionStack.length - 1];
        if (enclosing) {
          state.edges.push({
            edgeType: 'CALLS_FUNCTION',
            from: enclosing.id,
            to: pushed.id,
            sourceLine: node.getStartLineNumber(),
            arguments: [],
            isConditional: false,
            confidence: 'direct',
          });
        }
      }
    }
  } else if (Node.isMethodDeclaration(node)) {
    const cls = enclosingClassOrExpression(node);
    const cn = cls ? classNameOf(cls) : '<anonymous-class>';
    const isExported = !!cls && classIsExported(cls);
    pushed = recordFunction(state, node, `${cn}.${node.getName()}`, isExported);
  } else if (Node.isGetAccessorDeclaration(node)) {
    const cls = enclosingClassOrExpression(node);
    const cn = cls ? classNameOf(cls) : '<anonymous-class>';
    const isExported = !!cls && classIsExported(cls);
    pushed = recordFunction(state, node, `${cn}.get ${node.getName()}`, isExported);
  } else if (Node.isSetAccessorDeclaration(node)) {
    const cls = enclosingClassOrExpression(node);
    const cn = cls ? classNameOf(cls) : '<anonymous-class>';
    const isExported = !!cls && classIsExported(cls);
    pushed = recordFunction(state, node, `${cn}.set ${node.getName()}`, isExported);
  } else if (Node.isConstructorDeclaration(node)) {
    const cls = enclosingClassOrExpression(node);
    const cn = cls ? classNameOf(cls) : '<anonymous-class>';
    const isExported = !!cls && classIsExported(cls);
    pushed = recordFunction(state, node, `${cn}.constructor`, isExported);
  }

  // ── 2. Dispatch framework visitors for this node ────────────────
  // `enclosingFunction` is the stack top BEFORE pushing the
  // just-identified function-shape (if any). This means the visitor
  // sees a function declaration node with its *outer* function as the
  // enclosing context — the declaration statement lives in the outer
  // scope, not inside itself.
  if (state.visitors.length > 0) {
    // Mutate the shared context in place — see the comment where
    // `visitCtx` is allocated for the rationale. The `readonly`
    // marker on `TsVisitContext.enclosingFunction` is enforced for
    // *consumers* (visitors); the walker that owns the context is
    // explicitly allowed to update the field between dispatches via
    // this internal cast.
    (state.visitCtx as { enclosingFunction: FunctionDefinition | undefined }).enclosingFunction =
      state.functionStack[state.functionStack.length - 1];
    for (const visitor of state.visitors) {
      visitor.onNode(state.visitCtx, node);
    }
  }

  // ── 2b. Detect environment variable accesses (#139) ───────────────
  detectEnvVarAccess(node, state);

  // ── 2c. Detect request parameter accesses (#139) ─────────────────
  detectRequestFieldAccess(node, state);

  // Push AFTER visitor dispatch so children walked below see the
  // function-shape as their enclosing context.
  if (pushed) state.functionStack.push(pushed);

  // ── 3. Recurse into children ─────────────────────────────────────
  for (const child of node.getChildren()) {
    walkForExtraction(child, state);
  }

  // ── 4. Pop the pushed function on the way back up ───────────────
  if (pushed) state.functionStack.pop();
}

/**
 * Emit a `FunctionDefinition` node + `DEFINED_IN` edge for a
 * function-shaped declaration and index it in `fnByDeclaration`.
 * Returns the emitted `FunctionDefinition` so the walker can push it
 * onto the enclosing-function stack.
 */
function recordFunction(
  state: WalkState,
  node: Node,
  name: string,
  isExported: boolean
): FunctionDefinition {
  const fnDef = buildFunctionDefinitionNode(state.sourceFileId, state.filePath, node, name, isExported);
  state.nodes.push(fnDef);
  state.edges.push({ edgeType: 'DEFINED_IN', from: fnDef.id, to: state.sourceFileId });
  state.fnByDeclaration.set(node, fnDef);
  return fnDef;
}

/** Lifecycle hook names recognized for callback FunctionDefinition emission. */
const LIFECYCLE_HOOK_NAMES: ReadonlySet<string> = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
]);

/**
 * Suffix appended to a `serve(arrow)` / `Deno.serve(arrow)` handler's
 * inferred name. Exported so framework-supabase (and any other
 * framework that wants to resolve serve handlers) can compute the
 * handler's FunctionDefinition.id without re-deriving the suffix.
 */
export const SERVE_HANDLER_SUFFIX = '.serve$handler';

/**
 * Infer a synthetic name for an inline callback that should be emitted
 * as a `FunctionDefinition`. Returns `null` for callbacks we don't want
 * to name (e.g., `.then()` callbacks, `.map()` callbacks, etc.).
 *
 * Two patterns are recognized:
 *
 *   1. JSX attribute callback:
 *      `<form onSubmit={(e) => { ... }}>`
 *      → name: `ComponentName.onSubmit$callback`
 *
 *   2. Lifecycle hook callback:
 *      `useEffect(() => { ... }, [])`
 *      → name: `ComponentName.useEffect$callback`
 */
function inferCallbackName(node: Node, state: WalkState): string | null {
  const enclosingFn = state.functionStack[state.functionStack.length - 1];
  const prefix = enclosingFn?.name ?? '<module>';

  // Pattern 1: JSX attribute callback
  // AST shape: JsxAttribute > JsxExpression > ArrowFunction
  const parent = node.getParent();
  if (parent && Node.isJsxExpression(parent)) {
    const jsxAttr = parent.getParent();
    if (jsxAttr && Node.isJsxAttribute(jsxAttr)) {
      const nameNode = jsxAttr.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        return `${prefix}.${nameNode.getText()}$callback`;
      }
    }
  }

  // Pattern 2: Lifecycle hook callback (first argument to useEffect etc.)
  if (parent && Node.isCallExpression(parent)) {
    const callee = parent.getExpression();
    if (Node.isIdentifier(callee)) {
      const hookName = callee.getText();
      if (LIFECYCLE_HOOK_NAMES.has(hookName)) {
        const args = parent.getArguments();
        if (args.length > 0 && args[0] === node) {
          return `${prefix}.${hookName}$callback`;
        }
      }
    }
  }

  // Pattern 3: Route handler callback (Express/Fastify inline handlers)
  // AST shape: CallExpression > ArrowFunction (as last argument)
  // e.g., fastify.get('/path', async (req, reply) => { ... })
  //        app.get('/path', async (req, res) => { ... })
  if (parent && Node.isCallExpression(parent)) {
    const callee = parent.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
      const method = callee.getNameNode().getText();
      const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all']);
      if (HTTP_VERBS.has(method)) {
        const args = parent.getArguments();
        // Handler is the last arg that's a function (skip string path and options)
        if (args.length >= 2 && args[args.length - 1] === node) {
          const pathArg = args[0];
          if (Node.isStringLiteral(pathArg) || Node.isNoSubstitutionTemplateLiteral(pathArg)) {
            const route = pathArg.getLiteralValue();
            return `${method.toUpperCase()} ${route}$handler`;
          }
        }
      }
    }
  }

  // Pattern 5: Top-level Deno HTTP server callback
  // AST shape: CallExpression > ArrowFunction (single function arg)
  //   serve((req) => { ... })            // std/http import
  //   Deno.serve((req) => { ... })       // Deno builtin
  //   Deno.serve({ port: 8000 }, hndl)   // options + handler form
  // Used by Supabase Edge Functions (#254). Names the handler so
  // framework-supabase can resolve APIEndpoint.handlerFunctionId.
  if (parent && Node.isCallExpression(parent)) {
    const callee = parent.getExpression();
    let isDenoServe = false;
    if (Node.isIdentifier(callee) && callee.getText() === 'serve') {
      isDenoServe = true;
    } else if (
      Node.isPropertyAccessExpression(callee) &&
      callee.getNameNode().getText() === 'serve' &&
      Node.isIdentifier(callee.getExpression()) &&
      callee.getExpression().getText() === 'Deno'
    ) {
      isDenoServe = true;
    }
    if (isDenoServe) {
      const args = parent.getArguments();
      // Handler is whichever function-shaped argument we found.
      const handlerIdx = args.findIndex(
        (a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a),
      );
      if (handlerIdx >= 0 && args[handlerIdx] === node) {
        return `${prefix}${SERVE_HANDLER_SUFFIX}`;
      }
    }
  }

  // Pattern 4: Object literal property assignment
  // AST shape: PropertyAssignment > ArrowFunction
  // e.g., const api = { getUsers: () => fetchApi('/api/users') }
  if (parent && Node.isPropertyAssignment(parent)) {
    const propName = parent.getNameNode();
    if (Node.isIdentifier(propName)) {
      // Find the variable name from the enclosing object literal.
      const objLiteral = parent.getParent();
      if (objLiteral && Node.isObjectLiteralExpression(objLiteral)) {
        const varDecl = objLiteral.getParent();
        if (varDecl && Node.isVariableDeclaration(varDecl)) {
          return `${varDecl.getName()}.${propName.getText()}`;
        }
      }
      // Fallback: use just the property name.
      return propName.getText();
    }
  }

  return null;
}

function enclosingClassOrExpression(node: Node): Node | undefined {
  return node.getFirstAncestor((a) => Node.isClassDeclaration(a) || Node.isClassExpression(a));
}

function classNameOf(cls: Node): string {
  if (Node.isClassDeclaration(cls)) {
    return cls.getName() ?? '<anonymous-class>';
  }
  if (Node.isClassExpression(cls)) {
    const variable = cls.getParentIfKind(SyntaxKind.VariableDeclaration);
    return variable?.getName() ?? cls.getName() ?? '<anonymous-class>';
  }
  return '<anonymous-class>';
}

function classIsExported(cls: Node): boolean {
  if (Node.isClassDeclaration(cls)) {
    return cls.isExported() || cls.isDefaultExport();
  }
  // Class expression bound to an exported variable.
  const variable = cls.getParentIfKind?.(SyntaxKind.VariableDeclaration);
  if (variable) {
    const stmt = variable.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    return !!stmt && (stmt.isExported() || stmt.isDefaultExport());
  }
  return false;
}

function buildFunctionDefinitionNode(
  sourceFileId: string,
  filePath: string,
  node: Node,
  name: string,
  isExported: boolean
): FunctionDefinition {
  const sourceLine = node.getStartLineNumber();
  const parameters = extractParameters(node);
  const returnType = extractReturnType(node);
  const isAsync = extractIsAsync(node);

  const responses = extractResponses(node, parameters);

  const result: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId, name, sourceLine }),
    name,
    sourceFileId,
    sourceLine,
    parameters,
    returnType,
    isExported,
    isAsync,
    evidence: buildEvidence(node, filePath),
  };
  if (responses.length > 0) {
    result.responses = responses;
  }
  return result;
}

/**
 * Extract HTTP response shapes from a function that has an Express-style
 * `res` parameter. Detects patterns like:
 *   - `res.json(expr)`           → { status: 200, body: expr }
 *   - `res.status(N).json(expr)` → { status: N, body: expr }
 *   - `res.status(N).send()`     → { status: N, body: null }
 *   - `res.send(expr)`           → { status: 200, body: expr }
 *
 * Marks responses inside `if` or `catch` blocks as `isErrorPath: true`.
 */
function extractResponses(node: Node, parameters: Parameter[]): ResponseShape[] {
  // Only extract for functions that have a parameter named 'res' or typed 'Response'.
  const hasResParam = parameters.some(
    (p) => p.name === 'res' || p.type === 'Response'
  );
  if (!hasResParam) return [];

  const responses: ResponseShape[] = [];

  // Scan all call expressions in the function body.
  const callExprs = node.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExprs) {
    const shape = parseResponseCall(call, node);
    if (shape) responses.push(shape);
  }

  return responses;
}

/**
 * Try to parse a single call expression as an Express response call.
 * Returns null if it's not a response call.
 *
 * `functionNode` is the enclosing function, used to determine if the
 * response is inside a catch clause.
 */
function parseResponseCall(call: Node, functionNode: Node): ResponseShape | null {
  if (!Node.isCallExpression(call)) return null;

  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return null;

  const methodName = expr.getNameNode().getText();
  const receiver = expr.getExpression();

  // Pattern 1: res.json(body) or res.send(body)
  if ((methodName === 'json' || methodName === 'send') && Node.isIdentifier(receiver) && receiver.getText() === 'res') {
    const args = call.getArguments();
    const body = args.length > 0 ? truncateExpr(args[0].getText()) : null;
    const statusCode = 200;
    return {
      statusCode,
      bodyExpression: body,
      isErrorPath: isErrorStatus(statusCode) || isInsideCatchBlock(call, functionNode),
      sourceLine: call.getStartLineNumber(),
    };
  }

  // Pattern 2: res.status(N).json(body) or res.status(N).send(body)
  if ((methodName === 'json' || methodName === 'send') && Node.isCallExpression(receiver)) {
    const innerExpr = receiver.getExpression();
    if (!Node.isPropertyAccessExpression(innerExpr)) return null;
    const innerMethod = innerExpr.getNameNode().getText();
    const innerReceiver = innerExpr.getExpression();
    if (innerMethod !== 'status') return null;
    if (!Node.isIdentifier(innerReceiver) || innerReceiver.getText() !== 'res') return null;

    const statusArgs = receiver.getArguments();
    let statusCode: number | null = null;
    if (statusArgs.length > 0 && Node.isNumericLiteral(statusArgs[0])) {
      statusCode = Number(statusArgs[0].getLiteralValue());
    }

    const bodyArgs = call.getArguments();
    const body = bodyArgs.length > 0 ? truncateExpr(bodyArgs[0].getText()) : null;
    return {
      statusCode,
      bodyExpression: body,
      isErrorPath: isErrorStatus(statusCode) || isInsideCatchBlock(call, functionNode),
      sourceLine: call.getStartLineNumber(),
    };
  }

  return null;
}

/** 4xx and 5xx status codes are error responses. */
function isErrorStatus(statusCode: number | null): boolean {
  if (statusCode === null) return false;
  return statusCode >= 400;
}

/** Check if a node is inside a catch clause (but not past the function boundary). */
function isInsideCatchBlock(node: Node, functionNode: Node): boolean {
  let current = node.getParent();
  while (current && current !== functionNode) {
    if (Node.isCatchClause(current)) return true;
    current = current.getParent();
  }
  return false;
}

function truncateExpr(text: string): string {
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

/**
 * Extract parameter `{ name, type }` pairs from any function-shaped node.
 * Returns `[]` for nodes that don't carry parameters (defensive — the
 * caller already restricts which node kinds reach the builder).
 */
function extractParameters(node: Node): Parameter[] {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isConstructorDeclaration(node)
  ) {
    return node.getParameters().map((p) => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? null,
    }));
  }
  return [];
}

/** Extract the textual return type annotation, or `null` if unannotated. */
function extractReturnType(node: Node): string | null {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node)
  ) {
    return node.getReturnTypeNode()?.getText() ?? null;
  }
  // Setters and constructors do not have meaningful return types.
  return null;
}

/** True if the function-shaped node carries the `async` modifier. */
function extractIsAsync(node: Node): boolean {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  ) {
    return node.isAsync();
  }
  // Accessors and constructors are never async.
  return false;
}

/**
 * Name to stamp on the EXPORTS edge. For function declarations and class
 * methods it's the declared name; for arrow/fn-expr bound to a variable
 * we re-use the already-captured `fnName` (which is the variable name).
 * Returns `null` when the declaration isn't an exportable shape.
 */
function exportNameFor(decl: Node, fnName: string): string | null {
  // For top-level function declarations and methods, the function's
  // own name is the export name. For arrow / function expressions
  // assigned to a variable, ts-morph stores the export-ness on the
  // ancestor variable statement; the variable name is the fn name we
  // already captured.
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    return decl.getName() ?? fnName;
  }
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
    return fnName;
  }
  return null;
}

/**
 * True when `decl` is the function backing a `export default` declaration.
 *
 * Handles four shapes:
 *   1. `export default function foo() {}` — function declaration
 *   2. `export default class Foo { m() {} }` — method on a default-exported
 *      class (the method itself isn't individually default-exported, but it
 *      is reachable via the default binding)
 *   3. `export const foo = () => {}` / `function () {}` — not default
 *   4. `export default (() => {})` — arrow/fn-expr directly after
 *      `export default`, wrapped in an `ExportAssignment`
 *
 * Note: case (3) and (4) are disambiguated by walking to the nearest
 * `VariableStatement` or `ExportAssignment` ancestor — NOT by calling
 * `getFirstAncestorByKind(decl.getKind())` which asks for an ancestor of
 * the same kind as the declaration itself and is always undefined.
 */
function isDefaultExport(decl: Node): boolean {
  if (Node.isFunctionDeclaration(decl)) return decl.isDefaultExport();
  if (Node.isMethodDeclaration(decl)) {
    const cls = decl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    return !!cls && cls.isDefaultExport();
  }
  // Variable-bound arrow / function expression.
  const variableStatement = decl.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  if (variableStatement) {
    return variableStatement.isDefaultExport();
  }
  // `export default (() => {})` or `export default function () {}` as an
  // expression — the arrow/fn-expr is the expression of an ExportAssignment.
  const exportAssignment = decl.getFirstAncestorByKind(SyntaxKind.ExportAssignment);
  if (exportAssignment) {
    // ExportAssignment covers both `export default expr` and the legacy
    // `export = expr`. Only the former is a default export.
    return !exportAssignment.isExportEquals();
  }
  return false;
}

/**
 * Resolve a dynamic-import specifier (`import('./foo.js')`) to an
 * absolute file path that the project has loaded. Tries the
 * specifier verbatim, then probes common TS/JS extensions, then
 * tries `.js` → `.ts`/`.tsx` rewrites for the bundler convention
 * where authors write `.js` extensions in source for files that are
 * actually `.ts`. Returns `null` if nothing matches.
 */
function resolveDynamicImportTarget(
  internal: TsProjectInternal,
  fromFile: TsSourceFile,
  specifier: string
): string | null {
  const dir = path.dirname(fromFile.getFilePath());
  const base = path.resolve(dir, specifier);
  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.jsx',
    base + '.mjs',
    base + '.cjs',
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.jsx$/, '.tsx'),
  ];
  for (const candidate of candidates) {
    const file = internal.project.getSourceFile(candidate);
    if (file) return file.getFilePath();
  }
  return null;
}

function relativePath(rootDir: string, absolutePath: string): string {
  const rel = path.relative(rootDir, absolutePath);
  // Normalize path separators to POSIX so node ids are stable across
  // operating systems.
  return rel.split(path.sep).join('/');
}

// ──────────────────────────────────────────────────────────────────────
// Environment variable detection (#139)
// ──────────────────────────────────────────────────────────────────────

/**
 * Detect `process.env.VAR_NAME`, `process.env['VAR_NAME']`, and
 * `import.meta.env.VAR_NAME` patterns. Emits EnvironmentVariable nodes.
 */
function detectEnvVarAccess(node: Node, state: WalkState): void {
  if (!Node.isPropertyAccessExpression(node) && !Node.isElementAccessExpression(node)) return;

  let varName: string | null = null;
  let accessPattern: string = 'process.env';

  if (Node.isPropertyAccessExpression(node)) {
    // process.env.VAR_NAME or import.meta.env.VAR_NAME
    const objectText = node.getExpression().getText();
    const propName = node.getNameNode().getText();

    if (objectText === 'process.env') {
      varName = propName;
      accessPattern = 'process.env';
    } else if (objectText === 'import.meta.env') {
      varName = propName;
      accessPattern = 'import.meta.env';
    }
  } else if (Node.isElementAccessExpression(node)) {
    // process.env['VAR_NAME']
    const objectText = node.getExpression().getText();
    if (objectText === 'process.env') {
      const arg = node.getArgumentExpression();
      if (arg && Node.isStringLiteral(arg)) {
        varName = arg.getLiteralValue();
        accessPattern = 'process.env';
      }
    }
  }

  if (!varName) return;

  // Check if this access has a default value: X ?? 'default' or X || 'default'.
  // Only when `node` is the LEFT operand — `'foo' || process.env.X` doesn't
  // give X a default, it makes X the fallback.
  const parent = node.getParent();
  const hasDefault = Boolean(
    parent &&
    Node.isBinaryExpression(parent) &&
    parent.getLeft() === node &&
    ['??', '||'].includes(parent.getOperatorToken().getText())
  );

  const enclosingFn = state.functionStack[state.functionStack.length - 1];
  const envVar: EnvironmentVariable = {
    nodeType: 'EnvironmentVariable',
    id: idFor.environmentVariable({
      sourceFileId: state.sourceFileId,
      name: varName,
      sourceLine: node.getStartLineNumber(),
    }),
    name: varName,
    category: categorizeEnvVar(varName),
    hasDefault,
    accessPattern,
    sourceFileId: state.sourceFileId,
    sourceLine: node.getStartLineNumber(),
    functionId: enclosingFn?.id ?? null,
    repository: state.visitCtx.repository,
  };

  state.nodes.push(envVar);
}

/** Categorize an environment variable by its naming convention. */
function categorizeEnvVar(name: string): EnvVarCategory {
  const n = name.toUpperCase();
  if (/^(DATABASE|DB|MONGO|MYSQL|POSTGRES|PG|REDIS|SQLITE|CASSANDRA|DYNAMO)/.test(n)) return 'database';
  if (/^(JWT|AUTH|OAUTH|SESSION|SECRET|TOKEN|PASSWORD|CREDENTIALS|API_KEY|PRIVATE_KEY)/.test(n)) return 'auth';
  if (/^(API_|OPENAI|STRIPE|TWILIO|SENDGRID|FIREBASE|AWS|GCP|AZURE|WEBHOOK)/.test(n)) return 'api';
  if (/^(PORT|HOST|NODE_ENV|LOG|DEBUG|CORS|RATE_LIMIT|TIMEOUT|BASE_URL|APP_)/.test(n)) return 'config';
  return 'unknown';
}

// ──────────────────────────────────────────────────────────────────────
// Request field detection (#139)
// ──────────────────────────────────────────────────────────────────────

/**
 * Detect `req.body.field`, `req.params.id`, `req.query.search` patterns
 * and destructuring like `const { name } = req.body`. Attaches
 * requestFields to the enclosing FunctionDefinition.
 */
function detectRequestFieldAccess(node: Node, state: WalkState): void {
  const enclosingFn = state.functionStack[state.functionStack.length - 1];
  if (!enclosingFn) return;

  // Pattern 1: req.body.fieldName, req.params.id, req.query.search
  if (Node.isPropertyAccessExpression(node)) {
    const objectExpr = node.getExpression();
    if (!Node.isPropertyAccessExpression(objectExpr)) return;
    const source = objectExpr.getNameNode().getText();
    if (!['body', 'params', 'query', 'headers'].includes(source)) return;

    // Check that the root is a request-like object
    const rootObj = objectExpr.getExpression();
    if (!Node.isIdentifier(rootObj)) return;
    const rootName = rootObj.getText();
    if (!isRequestParam(rootName)) return;

    const fieldName = node.getNameNode().getText();
    addRequestField(enclosingFn, { name: fieldName, source: source as 'body' | 'params' | 'query' | 'headers', type: null });
    return;
  }

  // Pattern 2: const { name, email } = req.body
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (!initializer || !Node.isPropertyAccessExpression(initializer)) return;
    const source = initializer.getNameNode().getText();
    if (!['body', 'params', 'query', 'headers'].includes(source)) return;

    const rootObj = initializer.getExpression();
    if (!Node.isIdentifier(rootObj) || !isRequestParam(rootObj.getText())) return;

    const nameNode = node.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        const propName = element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText();
        addRequestField(enclosingFn, { name: propName, source: source as 'body' | 'params' | 'query' | 'headers', type: null });
      }
    }
  }
}

/**
 * Common identifiers used for the request object across TS frameworks:
 *   - Express / Fastify: `req`
 *   - NestJS `@Req()` / Hapi: `request`
 *   - Koa / Oak / tRPC: `ctx`
 */
const REQUEST_PARAM_NAMES = new Set(['req', 'request', 'ctx']);

function isRequestParam(name: string): boolean {
  return REQUEST_PARAM_NAMES.has(name);
}

function addRequestField(fn: FunctionDefinition, field: RequestField): void {
  if (!fn.requestFields) {
    Object.assign(fn, { requestFields: [] as RequestField[] });
  }
  const fields = fn.requestFields!;
  if (fields.some((f) => f.name === field.name && f.source === field.source)) return;
  fields.push(field);
}
