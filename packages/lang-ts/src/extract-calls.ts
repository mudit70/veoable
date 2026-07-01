import {
  Node,
  SyntaxKind,
  type CallExpression,
  type SourceFile as TsSourceFile,
} from 'ts-morph';
import { recordConfidenceDecision } from '@veoable/observability';
import type { CallConfidence, FunctionDefinition, SchemaEdge } from '@veoable/schema';
import { functionDefinitionIdFor, isFunctionShape } from './function-id.js';
import type { TsProjectInternal } from './project-handle.js';

/**
 * Walk every `CallExpression` in `file`, classify it by confidence,
 * resolve the callee to a `FunctionDefinition` id where possible, and
 * emit `CALLS_FUNCTION` edges. Also handles dynamic `import('./x')`
 * expressions, which are emitted as `IMPORTS` edges with
 * `isDynamic: true` rather than as call-graph edges.
 *
 * Confidence taxonomy (per #36):
 *   - `direct`   — statically resolvable free-function call
 *   - `method`   — method call where receiver type is known and the
 *                  method declaration is in the project
 *   - `indirect` — callee is a parameter or other locally bound
 *                  callback (the actual target is a runtime value)
 *   - `dynamic`  — `obj[name]()`, computed access, IIFE callee, etc.
 *
 * Every `indirect` and `dynamic` decision records a
 * `ConfidenceDecision` span event explaining the reason — this is the
 * hard rule from `@veoable/observability`.
 */
export interface CallExtractionResult {
  edges: SchemaEdge[];
}

export interface CallExtractionContext {
  /** Map from ts-morph function-shaped node to the FunctionDefinition that backs it. */
  fnByDeclaration: Map<Node, FunctionDefinition>;
}

export function extractCalls(
  internal: TsProjectInternal,
  file: TsSourceFile,
  ctx: CallExtractionContext
): CallExtractionResult {
  const edges: SchemaEdge[] = [];

  const callExpressions = file.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    // Dynamic imports are recorded as IMPORTS edges, not CALLS_FUNCTION.
    // Caller of `extractSourceFile` handles them separately so we skip
    // them here.
    if (isDynamicImport(call)) continue;

    const enclosing = enclosingFunctionDefinition(call, ctx.fnByDeclaration);
    if (!enclosing) {
      // Module top-level calls (import side effects, IIFEs at module
      // root) are not attributed to any function. Skipping them is
      // intentional and noted in the README.
      continue;
    }

    const resolved = resolveCall(call, internal);
    if (!resolved) {
      // External or unresolvable callee with nothing useful to record.
      continue;
    }

    if (resolved.confidence === 'indirect' || resolved.confidence === 'dynamic') {
      recordConfidenceDecision(resolved.reason ?? 'unspecified', {
        'call.confidence': resolved.confidence,
        'call.sourceLine': call.getStartLineNumber(),
        'call.text': truncate(call.getText(), 120),
      });
    }

    if (!resolved.calleeId) {
      // Confidence was determined but the callee target is not a
      // FunctionDefinition we emitted (e.g. parameter, external,
      // computed). Record nothing further — the decision span event
      // above is the only trace.
      continue;
    }

    edges.push({
      edgeType: 'CALLS_FUNCTION',
      from: enclosing.id,
      to: resolved.calleeId,
      sourceLine: call.getStartLineNumber(),
      arguments: call.getArguments().map((a) => truncate(a.getText(), 80)),
      isConditional: isInsideConditional(call),
      confidence: resolved.confidence,
    });
  }

  return { edges };
}

// ──────────────────────────────────────────────────────────────────────
// Dynamic imports
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk every dynamic `import('./x')` call expression in the file and
 * return them. The structural extractor calls this separately so it
 * can map dynamic imports onto IMPORTS edges with `isDynamic: true`,
 * which is consistent with how static imports are modeled.
 */
export function findDynamicImports(file: TsSourceFile): CallExpression[] {
  const result: CallExpression[] = [];
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (isDynamicImport(call)) result.push(call);
  }
  return result;
}

function isDynamicImport(call: CallExpression): boolean {
  // ts-morph models the dynamic-import callee as a syntax node of kind
  // `ImportKeyword`. Check via raw kind because there is no
  // `Node.isImportKeyword` predicate in older ts-morph versions.
  const expr = call.getExpression();
  return expr.getKind() === SyntaxKind.ImportKeyword;
}

// ──────────────────────────────────────────────────────────────────────
// Enclosing function discovery
// ──────────────────────────────────────────────────────────────────────

function enclosingFunctionDefinition(
  call: CallExpression,
  fnByDeclaration: Map<Node, FunctionDefinition>
): FunctionDefinition | null {
  let current: Node | undefined = call.getParent();
  while (current) {
    if (isFunctionShape(current)) {
      const fnDef = fnByDeclaration.get(current);
      if (fnDef) return fnDef;
    }
    current = current.getParent();
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Call resolution
// ──────────────────────────────────────────────────────────────────────

interface ResolvedCall {
  confidence: CallConfidence;
  /** id of the callee FunctionDefinition, if known and in-project. */
  calleeId: string | null;
  /** Reason for indirect / dynamic decisions. */
  reason?: string;
}

/** May return `null` for external callees we deliberately do not record. */
function resolveCall(call: CallExpression, internal: TsProjectInternal): ResolvedCall | null {
  const callee = call.getExpression();

  // Computed property access — `obj[name]()`
  if (Node.isElementAccessExpression(callee)) {
    return {
      confidence: 'dynamic',
      calleeId: null,
      reason: 'computed property access',
    };
  }

  // Method call — `obj.foo()` or `Class.foo()`
  if (Node.isPropertyAccessExpression(callee)) {
    return resolvePropertyAccessCall(callee, internal);
  }

  // Free-function or callback call — `foo()`
  if (Node.isIdentifier(callee)) {
    return resolveIdentifierCall(callee, internal);
  }

  // Anything else: IIFE `(() => {})()`, `(getFn())()`, etc.
  return {
    confidence: 'dynamic',
    calleeId: null,
    reason: 'non-trivial callee expression',
  };
}

function resolvePropertyAccessCall(
  callee: Node,
  internal: TsProjectInternal
): ResolvedCall | null {
  if (!Node.isPropertyAccessExpression(callee)) {
    return { confidence: 'dynamic', calleeId: null, reason: 'non-property-access callee' };
  }
  const nameNode = callee.getNameNode();
  const symbol = nameNode.getSymbol();
  if (!symbol) {
    return {
      confidence: 'dynamic',
      calleeId: null,
      reason: 'unresolved property access',
    };
  }
  const declarations = symbol.getDeclarations();
  // Prefer in-project declarations.
  const inProject = declarations.find((d) => declarationIsInProject(d, internal));
  if (!inProject) {
    // External (e.g. console.log, fetch). We do not emit an edge —
    // external nodes are not in the call graph at this layer.
    return null;
  }
  // The declaration may be the function itself, or a PropertyAssignment
  // whose initializer is a function (object literal methods).
  let targetNode: Node = inProject;
  if (Node.isPropertyAssignment(inProject)) {
    const init = inProject.getInitializer();
    if (init && isFunctionShape(init)) {
      targetNode = init;
    }
  }

  if (!isFunctionShape(targetNode)) {
    return {
      confidence: 'dynamic',
      calleeId: null,
      reason: 'property resolves to a non-function declaration',
    };
  }
  const calleeId = functionDefinitionIdFor(internal, targetNode);
  return {
    confidence: 'method',
    calleeId,
  };
}

function resolveIdentifierCall(callee: Node, internal: TsProjectInternal): ResolvedCall | null {
  if (!Node.isIdentifier(callee)) {
    return { confidence: 'dynamic', calleeId: null, reason: 'non-identifier callee' };
  }
  const symbol = callee.getSymbol();
  if (!symbol) {
    return {
      confidence: 'dynamic',
      calleeId: null,
      reason: 'unresolved identifier',
    };
  }
  const declarations = symbol.getDeclarations();
  if (declarations.length === 0) {
    return {
      confidence: 'dynamic',
      calleeId: null,
      reason: 'identifier has no declarations',
    };
  }

  // Look at the first in-project declaration; fall back to the first.
  const decl = declarations.find((d) => declarationIsInProject(d, internal)) ?? declarations[0];

  // Parameter — callback flowing in as an argument.
  if (Node.isParameterDeclaration(decl)) {
    return {
      confidence: 'indirect',
      calleeId: null,
      reason: 'callback passed as parameter',
    };
  }

  // VariableDeclaration whose initializer is a function — `direct`.
  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      if (!declarationIsInProject(decl, internal)) return null;
      return {
        confidence: 'direct',
        calleeId: functionDefinitionIdFor(internal, initializer),
      };
    }
    // Variable that holds a runtime value — indirect.
    return {
      confidence: 'indirect',
      calleeId: null,
      reason: 'identifier resolves to a non-function variable',
    };
  }

  // Function declaration — direct.
  if (Node.isFunctionDeclaration(decl)) {
    if (!declarationIsInProject(decl, internal)) return null;
    return {
      confidence: 'direct',
      calleeId: functionDefinitionIdFor(internal, decl),
    };
  }

  // Imported binding (ImportSpecifier / ImportClause / NamespaceImport).
  // Resolve through to the actual exported declaration.
  if (
    Node.isImportSpecifier(decl) ||
    Node.isImportClause(decl) ||
    Node.isNamespaceImport(decl)
  ) {
    // The aliased symbol is the real export target.
    const aliased = symbol.getAliasedSymbol();
    if (!aliased) {
      return { confidence: 'dynamic', calleeId: null, reason: 'unresolved import alias' };
    }
    const aliasedDecls = aliased.getDeclarations();
    const target = aliasedDecls.find((d) => declarationIsInProject(d, internal));
    if (!target) return null; // external
    // The aliased declaration may be a VariableDeclaration whose
    // initializer is an arrow/fn-expr (`export const foo = () => {}`).
    // Unwrap it so we resolve to the actual function-shaped node that
    // backs the FunctionDefinition we emitted.
    const fnNode = unwrapToFunctionShape(target);
    if (!fnNode) {
      return {
        confidence: 'dynamic',
        calleeId: null,
        reason: 'import resolves to a non-function declaration',
      };
    }
    return {
      confidence: 'direct',
      calleeId: functionDefinitionIdFor(internal, fnNode),
    };
  }

  return {
    confidence: 'dynamic',
    calleeId: null,
    reason: `unrecognized callee declaration kind: ${decl.getKindName()}`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a declaration node to the function-shaped node it represents,
 * if any. Handles two shapes:
 *   - the declaration is itself function-shaped (returns it unchanged)
 *   - the declaration is a `VariableDeclaration` whose initializer is
 *     an arrow function or function expression (returns the initializer)
 *
 * Returns `null` for any other shape (e.g. a class or interface).
 */
function unwrapToFunctionShape(decl: Node): Node | null {
  if (isFunctionShape(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer;
    }
  }
  return null;
}

function declarationIsInProject(decl: Node, internal: TsProjectInternal): boolean {
  const filePath = decl.getSourceFile().getFilePath();
  return filePath.startsWith(internal.rootDir);
}

function isInsideConditional(call: CallExpression): boolean {
  let current: Node | undefined = call.getParent();
  while (current) {
    if (
      Node.isIfStatement(current) ||
      Node.isConditionalExpression(current) ||
      Node.isCaseClause(current) ||
      Node.isWhileStatement(current) ||
      Node.isForStatement(current) ||
      Node.isForInStatement(current) ||
      Node.isForOfStatement(current)
    ) {
      return true;
    }
    if (Node.isBinaryExpression(current)) {
      const op = current.getOperatorToken().getText();
      if (op === '&&' || op === '||' || op === '??') return true;
    }
    // Stop walking at function boundary — anything outside the
    // enclosing function is not part of this call's control flow.
    if (isFunctionShape(current)) return false;
    current = current.getParent();
  }
  return false;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
