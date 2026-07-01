import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
type Tree = Parser.Tree;
import {
  idFor,
  type SchemaNode,
  type SchemaEdge,
  type SourceFile,
  type FunctionDefinition,
  type DefinedInEdge,
  type ExportsEdge,
  type CallsFunctionEdge,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import type { RustFrameworkVisitor, RustVisitContext } from './framework-visitor.js';

/**
 * Extract nodes and edges from a single Rust source file using tree-sitter.
 *
 * Produces:
 *   - SourceFile node
 *   - FunctionDefinition nodes for all functions and methods
 *   - DEFINED_IN edges (FunctionDefinition → SourceFile)
 *   - EXPORTS edges for `pub` functions/methods
 *   - CALLS_FUNCTION edges for function/method calls
 *
 * Rust-specific considerations:
 *   - Visibility: `pub` / `pub(crate)` = exported, no modifier = private
 *   - `impl Type { fn method() {} }` → `Type.method`
 *   - `impl Trait for Type { fn method() {} }` → `Type.method`
 *   - `async fn` → `isAsync: true` (also handles `unsafe async fn`)
 *   - `const fn`, `unsafe fn`, `extern fn` → extracted as normal functions
 *   - `self.method()` → resolves to `Type.method` (within impl block)
 *   - `Self::method()` → resolves to `Type.method` (M1 fix)
 *   - `Type::method()` → resolves to `Type.method` (scoped call)
 *   - Trait method signatures (without body) are extracted
 *   - Closures (`|x| x + 1`) — calls inside attributed to enclosing fn
 *     via walkChildren fallthrough
 *   - Macro invocations (`println!()`) — skipped; macro contents are
 *     opaque token trees, so calls inside macros (e.g., `assert_eq!(foo(), bar())`)
 *     will not generate call edges. This is a known limitation.
 *
 * Two-pass extraction:
 *   - Top-level functions use two-pass at file scope (M2 fix): first pass
 *     collects all top-level function signatures, second pass walks bodies.
 *   - impl blocks use two-pass within each block.
 *   - Trait blocks use two-pass for default method implementations (m4 fix).
 *
 * Known limitation — name collisions:
 *   When a type has both an inherent impl and a trait impl defining the same
 *   method name (e.g., `UserService.find_by_id` from both), the second
 *   overwrites the first in `fnByName`. Call edges may resolve to the wrong
 *   overload. This is analogous to Java's method overload collision (M3).
 *
 * TODO: Rust import resolution — `use_declaration` and `mod` nodes are
 *   dispatched to visitors but do not emit IMPORTS edges. Resolving Rust
 *   imports requires understanding the module system (mod.rs, file
 *   structure, crate dependencies from Cargo.toml).
 */
export function extractRustFile(
  tree: Tree,
  filePath: string,
  repository: string,
  rootDir: string,
  visitors: RustFrameworkVisitor[]
): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const posixPath = filePath.replace(/\\/g, '/');

  const sourceFileId = idFor.sourceFile({ repository, filePath: posixPath });
  const sourceFile: SourceFile = {
    nodeType: 'SourceFile',
    id: sourceFileId,
    filePath: posixPath,
    repository,
    language: 'rust',
    framework: null,
  };
  nodes.push(sourceFile);

  const fnByName = new Map<string, FunctionDefinition>();
  const functionStack: FunctionDefinition[] = [];

  const visitCtx: RustVisitContext = {
    sourceFile,
    get enclosingFunction() { return functionStack[functionStack.length - 1]; },
    rootDir,
    repository,
    emitNode(n) { nodes.push(n); },
    emitEdge(e) { edges.push(e); },
  };

  function registerFunction(
    fullName: string,
    node: SyntaxNode,
    line: number,
    exported: boolean,
    params: Array<{ name: string; type: string | null }>,
    returnType: string | null,
    isAsync: boolean,
    exportName: string,
  ): FunctionDefinition {
    const fnDef: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name: fullName, sourceLine: line }),
      name: fullName,
      sourceFileId,
      sourceLine: line,
      parameters: params,
      returnType,
      isExported: exported,
      isAsync,
    };
    nodes.push(fnDef);
    edges.push({ edgeType: 'DEFINED_IN', from: fnDef.id, to: sourceFileId } as DefinedInEdge);
    fnByName.set(fullName, fnDef);

    if (exported) {
      edges.push({
        edgeType: 'EXPORTS',
        from: sourceFileId,
        to: fnDef.id,
        exportName,
        isDefault: false,
      } as ExportsEdge);
    }

    return fnDef;
  }

  /**
   * Two-pass impl block processing.
   */
  function processImplBlock(node: SyntaxNode): void {
    const typeName = extractImplTypeName(node);
    if (!typeName) return;

    const declList = node.childForFieldName('body');
    if (!declList) return;

    interface MethodInfo {
      node: SyntaxNode;
      fnDef: FunctionDefinition;
      bodyNode: SyntaxNode | null;
    }
    const methods: MethodInfo[] = [];

    // Pass 1: collect method signatures
    for (let i = 0; i < declList.childCount; i++) {
      const child = declList.child(i)!;
      if (child.type === 'function_item') {
        const nameNode = child.childForFieldName('name');
        const methodName = nameNode?.text ?? '<anonymous>';
        const fullName = `${typeName}.${methodName}`;
        const line = child.startPosition.row + 1;
        const exported = hasVisibilityModifier(child);
        const params = extractParameters(child);
        const returnType = extractReturnType(child);
        const isAsync = hasAsyncModifier(child);

        const fnDef = registerFunction(fullName, child, line, exported, params, returnType, isAsync, methodName);
        methods.push({ node: child, fnDef, bodyNode: child.childForFieldName('body') });
      }
    }

    // Pass 2: walk method bodies
    for (const { node: methodNode, fnDef, bodyNode } of methods) {
      for (const visitor of visitors) visitor.onNode(visitCtx, methodNode);

      if (bodyNode) {
        functionStack.push(fnDef);
        walkChildren(bodyNode, typeName);
        functionStack.pop();
      }
    }
  }

  /**
   * Two-pass trait block processing (m4 fix).
   */
  function processTraitBlock(node: SyntaxNode): void {
    const nameNode = node.childForFieldName('name');
    const traitName = nameNode?.text ?? '<anonymous>';

    const declList = node.childForFieldName('body');
    if (!declList) return;

    interface TraitMethodInfo {
      node: SyntaxNode;
      fnDef: FunctionDefinition;
      bodyNode: SyntaxNode | null;
    }
    const methods: TraitMethodInfo[] = [];

    // Pass 1: collect all trait method signatures
    for (let i = 0; i < declList.childCount; i++) {
      const child = declList.child(i)!;
      if (child.type === 'function_signature_item' || child.type === 'function_item') {
        const methodNameNode = child.childForFieldName('name');
        const methodName = methodNameNode?.text ?? '<anonymous>';
        const fullName = `${traitName}.${methodName}`;
        const line = child.startPosition.row + 1;
        const params = extractParameters(child);
        const returnType = extractReturnType(child);
        const isAsync = hasAsyncModifier(child);

        const fnDef = registerFunction(fullName, child, line, true, params, returnType, isAsync, methodName);
        const bodyNode = child.type === 'function_item' ? child.childForFieldName('body') : null;
        methods.push({ node: child, fnDef, bodyNode });
      }
    }

    // Pass 2: walk default method bodies
    for (const { node: methodNode, fnDef, bodyNode } of methods) {
      for (const visitor of visitors) visitor.onNode(visitCtx, methodNode);

      if (bodyNode) {
        functionStack.push(fnDef);
        walkChildren(bodyNode, traitName);
        functionStack.pop();
      }
    }
  }

  // ── M2 fix: Two-pass for top-level functions ───────────────────
  // First pass: register all top-level function signatures.
  // Second pass: walk their bodies for call resolution.
  // This ensures forward references between top-level functions resolve.
  interface TopLevelFnInfo {
    node: SyntaxNode;
    fnDef: FunctionDefinition;
    bodyNode: SyntaxNode | null;
  }
  const topLevelFunctions: TopLevelFnInfo[] = [];

  function collectTopLevelFunctions(rootNode: SyntaxNode): void {
    for (let i = 0; i < rootNode.childCount; i++) {
      const child = rootNode.child(i)!;
      if (child.type === 'function_item') {
        const nameNode = child.childForFieldName('name');
        const name = nameNode?.text ?? '<anonymous>';
        const line = child.startPosition.row + 1;
        const exported = hasVisibilityModifier(child);
        const params = extractParameters(child);
        const returnType = extractReturnType(child);
        const isAsync = hasAsyncModifier(child);

        const fnDef = registerFunction(name, child, line, exported, params, returnType, isAsync, name);
        topLevelFunctions.push({ node: child, fnDef, bodyNode: child.childForFieldName('body') });
      }
    }
  }

  function walk(node: SyntaxNode, selfTypeName: string | null): void {
    // ── impl blocks ────────────────────────────────────────────────
    if (node.type === 'impl_item') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      processImplBlock(node);
      return;
    }

    // ── trait declarations ─────────────────────────────────────────
    if (node.type === 'trait_item') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      processTraitBlock(node);
      return;
    }

    // ── Top-level function items — skip during walk (handled in two-pass) ─
    if (node.type === 'function_item' && !selfTypeName) {
      return; // Already registered in collectTopLevelFunctions
    }

    // ── Struct/enum declarations (dispatch to visitors) ────────────
    if (node.type === 'struct_item' || node.type === 'enum_item') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      return;
    }

    // ── Use declarations (imports) ─────────────────────────────────
    // TODO: Rust import resolution — see JSDoc above.
    if (node.type === 'use_declaration') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      return;
    }

    // ── Mod declarations ───────────────────────────────────────────
    if (node.type === 'mod_item') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      const body = node.childForFieldName('body');
      if (body) walkChildren(body, selfTypeName);
      return;
    }

    // ── Call expressions ───────────────────────────────────────────
    if (node.type === 'call_expression') {
      extractCall(node, selfTypeName);
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      walkChildren(node, selfTypeName);
      return;
    }

    // ── Macro invocations — dispatch but don't walk children ───────
    // Macro contents are opaque token trees. Calls inside macros
    // (e.g., `assert_eq!(foo(), bar())`) will not generate call edges.
    if (node.type === 'macro_invocation') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      return;
    }

    // ── Attribute items — dispatch for framework detection ─────────
    if (node.type === 'attribute_item') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      return;
    }

    // ── All other nodes: dispatch + recurse ────────────────────────
    for (const visitor of visitors) visitor.onNode(visitCtx, node);
    walkChildren(node, selfTypeName);
  }

  function walkChildren(node: SyntaxNode, selfTypeName: string | null): void {
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, selfTypeName);
    }
  }

  function extractCall(node: SyntaxNode, selfTypeName: string | null): void {
    const enclosing = functionStack[functionStack.length - 1];
    if (!enclosing) return;

    const fnNode = node.childForFieldName('function');
    if (!fnNode) return;

    let calleeName: string | null = null;
    let confidence: 'direct' | 'method' | 'dynamic' = 'dynamic';

    if (fnNode.type === 'identifier') {
      calleeName = fnNode.text;
      confidence = 'direct';
    } else if (fnNode.type === 'scoped_identifier') {
      // Scoped call: Type::method() or Self::method()
      const pathNode = fnNode.childForFieldName('path');
      const nameNode = fnNode.childForFieldName('name');
      if (pathNode && nameNode) {
        // M1 fix: resolve Self:: to the impl type name
        if (pathNode.text === 'Self' && selfTypeName) {
          calleeName = `${selfTypeName}.${nameNode.text}`;
        } else {
          calleeName = `${pathNode.text}.${nameNode.text}`;
        }
        confidence = 'direct';
      }
    } else if (fnNode.type === 'field_expression') {
      // Method call: self.method() or obj.method()
      const field = fnNode.childForFieldName('field');
      const value = fnNode.childForFieldName('value');
      if (field && value) {
        const objText = value.text;
        if (objText === 'self' && selfTypeName) {
          calleeName = `${selfTypeName}.${field.text}`;
          confidence = 'direct';
        } else {
          calleeName = `${objText}.${field.text}`;
          confidence = 'method';
        }
      }
    }

    if (!calleeName) return;
    const target = fnByName.get(calleeName);
    if (!target) return;

    const args = node.childForFieldName('arguments');
    const argTexts: string[] = [];
    if (args) {
      for (let i = 0; i < args.childCount; i++) {
        const child = args.child(i)!;
        if (child.type !== '(' && child.type !== ')' && child.type !== ',') {
          argTexts.push(child.text.slice(0, 80));
        }
      }
    }

    edges.push({
      edgeType: 'CALLS_FUNCTION',
      from: enclosing.id,
      to: target.id,
      sourceLine: node.startPosition.row + 1,
      arguments: argTexts.slice(0, 5),
      isConditional: isInsideConditional(node),
      confidence,
    } as CallsFunctionEdge);
  }

  // ── Execute two-pass extraction ──────────────────────────────────
  // Pass 1: Register all top-level function signatures
  collectTopLevelFunctions(tree.rootNode);

  // Walk non-function top-level items (impl blocks, traits, structs, etc.)
  for (let i = 0; i < tree.rootNode.childCount; i++) {
    const child = tree.rootNode.child(i)!;
    if (child.type !== 'function_item') {
      walk(child, null);
    }
  }

  // Pass 2: Walk top-level function bodies
  for (const { node, fnDef, bodyNode } of topLevelFunctions) {
    for (const visitor of visitors) visitor.onNode(visitCtx, node);

    if (bodyNode) {
      functionStack.push(fnDef);
      walkChildren(bodyNode, null);
      functionStack.pop();
    }
  }

  return { nodes, edges };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract the type name being implemented from an impl block.
 *
 * `impl UserService { ... }` → 'UserService'
 * `impl Repository for UserService { ... }` → 'UserService'
 */
function extractImplTypeName(node: SyntaxNode): string | null {
  let hasFor = false;
  let lastTypeBeforeFor: string | null = null;
  let typeAfterFor: string | null = null;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'for') {
      hasFor = true;
      continue;
    }
    if (child.type === 'type_identifier' || child.type === 'scoped_type_identifier' || child.type === 'generic_type') {
      const typeName = child.type === 'generic_type'
        ? (child.children.find(c => c.type === 'type_identifier')?.text ?? child.text)
        : child.text;
      if (hasFor) {
        typeAfterFor = typeName;
      } else {
        lastTypeBeforeFor = typeName;
      }
    }
  }

  return typeAfterFor ?? lastTypeBeforeFor;
}

function hasVisibilityModifier(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)!.type === 'visibility_modifier') return true;
  }
  return false;
}

/**
 * Check for async modifier. Handles `async fn`, `unsafe async fn`, etc.
 * Uses explicit child iteration instead of string `.includes()` (m1 fix).
 */
function hasAsyncModifier(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'function_modifiers') {
      for (let j = 0; j < child.childCount; j++) {
        if (child.child(j)!.text === 'async') return true;
      }
    }
  }
  return false;
}

/**
 * Extract parameters from a function_item or function_signature_item.
 * Skips `self` parameter (receiver).
 */
function extractParameters(node: SyntaxNode): Array<{ name: string; type: string | null }> {
  const paramsNode = node.childForFieldName('parameters');
  if (!paramsNode) return [];

  const result: Array<{ name: string; type: string | null }> = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i)!;
    if (child.type === 'self_parameter') continue;

    if (child.type === 'parameter') {
      let name = '_';
      let paramType: string | null = null;

      const pattern = child.childForFieldName('pattern');
      if (pattern) {
        name = pattern.text;
      } else {
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j)!;
          if (c.type === 'identifier') { name = c.text; break; }
        }
      }

      const typeNode = child.childForFieldName('type');
      if (typeNode) paramType = typeNode.text;

      result.push({ name, type: paramType });
    }
  }
  return result;
}

function extractReturnType(node: SyntaxNode): string | null {
  const retType = node.childForFieldName('return_type');
  return retType?.text ?? null;
}

function isInsideConditional(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'if_expression' ||
      current.type === 'if_let_expression' ||
      current.type === 'for_expression' ||
      current.type === 'while_expression' ||
      current.type === 'while_let_expression' ||
      current.type === 'loop_expression' ||
      current.type === 'match_expression'
    ) {
      return true;
    }
    if (current.type === 'function_item') break;
    current = current.parent;
  }
  return false;
}
