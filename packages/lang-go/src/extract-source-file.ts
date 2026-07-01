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
import type { GoFrameworkVisitor, GoVisitContext } from './framework-visitor.js';

/**
 * Extract nodes and edges from a single Go source file using tree-sitter.
 *
 * Produces:
 *   - SourceFile node
 *   - FunctionDefinition nodes for all functions and methods
 *   - DEFINED_IN edges (FunctionDefinition → SourceFile)
 *   - EXPORTS edges for exported functions (Go: uppercase first letter)
 *   - CALLS_FUNCTION edges for function/method calls
 *
 * Go-specific considerations:
 *   - Exported = name starts with uppercase letter
 *   - Method receivers: `func (s *Server) Handle()` → `Server.Handle`
 *   - No decorators — framework patterns are via function call shapes
 *   - `go func(){}()` goroutine spawns are noted via call edges
 *
 * Known limitation — single-pass walk:
 *   The AST is walked top-to-bottom in a single pass. Functions are
 *   registered in `fnByName` as they are encountered, so a function
 *   calling another function defined LATER in the same file will NOT
 *   produce a CALLS_FUNCTION edge. In Go (unlike Python), declaration
 *   order is irrelevant for compilation — all package-level names are
 *   visible to each other. A two-pass approach (first pass: collect all
 *   declarations; second pass: resolve calls) would fix this but adds
 *   complexity. The current approach matches lang-py's behavior and is
 *   sufficient for most real-world codebases where called functions
 *   tend to be defined before their callers or in separate files.
 */
export function extractGoFile(
  tree: Tree,
  filePath: string,
  repository: string,
  rootDir: string,
  visitors: GoFrameworkVisitor[]
): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const posixPath = filePath.replace(/\\/g, '/');

  // SourceFile node.
  const sourceFileId = idFor.sourceFile({ repository, filePath: posixPath });
  const sourceFile: SourceFile = {
    nodeType: 'SourceFile',
    id: sourceFileId,
    filePath: posixPath,
    repository,
    language: 'go',
    framework: null,
  };
  nodes.push(sourceFile);

  // Track functions for call resolution.
  const fnByName = new Map<string, FunctionDefinition>();
  const functionStack: FunctionDefinition[] = [];

  // Visit context for framework visitors.
  const visitCtx: GoVisitContext = {
    sourceFile,
    get enclosingFunction() { return functionStack[functionStack.length - 1]; },
    rootDir,
    repository,
    emitNode(n) { nodes.push(n); },
    emitEdge(e) { edges.push(e); },
  };

  // Recursive AST walk.
  function walk(node: SyntaxNode): void {
    // ── Function declarations: `func Name(...) ... { ... }` ────────
    if (node.type === 'function_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text ?? '<anonymous>';
      const line = node.startPosition.row + 1;

      const fnDef = emitFunctionDefinition(name, node, line, isExportedName(name));

      // Dispatch framework visitors.
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }

      // Walk body with this function on the stack.
      functionStack.push(fnDef);
      const body = node.childForFieldName('body');
      if (body) walkChildren(body);
      functionStack.pop();
      return;
    }

    // ── Method declarations: `func (recv *Type) Name(...) ... { ... }` ─
    if (node.type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      const methodName = nameNode?.text ?? '<anonymous>';
      const receiverType = extractReceiverType(node);
      const fullName = receiverType ? `${receiverType}.${methodName}` : methodName;
      const line = node.startPosition.row + 1;

      const fnDef = emitFunctionDefinition(fullName, node, line, isExportedName(methodName));

      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }

      functionStack.push(fnDef);
      const body = node.childForFieldName('body');
      if (body) walkChildren(body);
      functionStack.pop();
      return;
    }

    // ── Type declarations (struct, interface) ──────────────────────
    if (node.type === 'type_declaration') {
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }
      walkChildren(node);
      return;
    }

    // ── Import declarations ────────────────────────────────────────
    // TODO: Go import resolution — currently dispatches to visitors but
    // does not emit IMPORTS edges. Emitting IMPORTS edges requires
    // resolving Go import paths (e.g., "github.com/example/pkg") to
    // actual source files, which needs go.mod parsing, GOPATH/module
    // cache awareness, and package path resolution. For now, imports
    // are parsed for framework visitor dispatch only. Cross-file call
    // resolution relies on name matching within the same analysis run.
    if (node.type === 'import_declaration') {
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }
      return;
    }

    // ── Call expressions ───────────────────────────────────────────
    if (node.type === 'call_expression') {
      extractCall(node);
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }
      walkChildren(node);
      return;
    }

    // ── Go statements (goroutine spawns): `go func() {}()` ────────
    if (node.type === 'go_statement') {
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }
      walkChildren(node);
      return;
    }

    // ── All other nodes: dispatch + recurse ────────────────────────
    for (const visitor of visitors) {
      visitor.onNode(visitCtx, node);
    }
    walkChildren(node);
  }

  function walkChildren(node: SyntaxNode): void {
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!);
    }
  }

  function emitFunctionDefinition(
    name: string,
    node: SyntaxNode,
    line: number,
    exported: boolean,
  ): FunctionDefinition {
    const params = extractParameters(node);
    const returnType = extractReturnType(node);
    const isAsync = false; // Go doesn't have async/await; goroutines are separate

    const fnDef: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name, sourceLine: line }),
      name,
      sourceFileId,
      sourceLine: line,
      parameters: params,
      returnType,
      isExported: exported,
      isAsync,
    };
    nodes.push(fnDef);
    edges.push({ edgeType: 'DEFINED_IN', from: fnDef.id, to: sourceFileId } as DefinedInEdge);
    fnByName.set(name, fnDef);

    if (exported) {
      // Extract the bare name (without receiver type prefix) for exportName.
      const dotIdx = name.indexOf('.');
      const exportName = dotIdx >= 0 ? name.slice(dotIdx + 1) : name;
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

  function extractCall(node: SyntaxNode): void {
    const enclosing = functionStack[functionStack.length - 1];
    if (!enclosing) return;

    const callee = node.childForFieldName('function');
    if (!callee) return;

    let calleeName: string | null = null;
    let confidence: 'direct' | 'method' | 'indirect' | 'dynamic' = 'dynamic';

    if (callee.type === 'identifier') {
      calleeName = callee.text;
      confidence = 'direct';
    } else if (callee.type === 'selector_expression') {
      // obj.Method() → try to resolve as ClassName.Method
      const operand = callee.childForFieldName('operand');
      const field = callee.childForFieldName('field');
      if (operand && field) {
        calleeName = `${operand.text}.${field.text}`;
        confidence = 'method';
      }
    }

    // Try to resolve to a known function.
    let targetId: string | null = null;
    if (calleeName) {
      const target = fnByName.get(calleeName);
      if (target) {
        targetId = target.id;
        if (confidence === 'dynamic') confidence = 'direct';
      }
    }

    if (targetId) {
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
        to: targetId,
        sourceLine: node.startPosition.row + 1,
        arguments: argTexts.slice(0, 5),
        isConditional: isInsideConditional(node),
        confidence,
      } as CallsFunctionEdge);
    }
  }

  walk(tree.rootNode);

  return { nodes, edges };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Go export convention: identifiers starting with an uppercase letter are exported.
 */
function isExportedName(name: string): boolean {
  if (!name || name.length === 0) return false;
  const first = name.charAt(0);
  return first >= 'A' && first <= 'Z';
}

/**
 * Extract the receiver type from a method declaration.
 *
 * `func (s *UserService) GetAll() []User` → 'UserService'
 * `func (s UserService) String() string` → 'UserService'
 */
function extractReceiverType(node: SyntaxNode): string | null {
  // The receiver is the first parameter_list before the method name.
  // In tree-sitter-go: method_declaration has receiver as first parameter_list child.
  const children = node.children;
  let receiverList: SyntaxNode | null = null;
  for (const child of children) {
    if (child.type === 'parameter_list') {
      receiverList = child;
      break; // First parameter_list is the receiver
    }
  }
  if (!receiverList) return null;

  // Find the type within the receiver parameter_list.
  for (let i = 0; i < receiverList.childCount; i++) {
    const param = receiverList.child(i)!;
    if (param.type === 'parameter_declaration') {
      // Look for type_identifier or pointer_type > type_identifier
      for (let j = 0; j < param.childCount; j++) {
        const c = param.child(j)!;
        if (c.type === 'type_identifier') return c.text;
        if (c.type === 'pointer_type') {
          for (let k = 0; k < c.childCount; k++) {
            if (c.child(k)!.type === 'type_identifier') return c.child(k)!.text;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Extract parameters from a function or method declaration.
 *
 * For methods, skips the receiver parameter_list (first one) and
 * uses the second parameter_list.
 */
function extractParameters(node: SyntaxNode): Array<{ name: string; type: string | null }> {
  const isMethod = node.type === 'method_declaration';
  const paramLists = node.children.filter((c) => c.type === 'parameter_list');

  // For functions: first param_list is the parameters.
  // For methods: first is receiver, second is parameters.
  const paramsNode = isMethod ? paramLists[1] : paramLists[0];
  if (!paramsNode) return [];

  const result: Array<{ name: string; type: string | null }> = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i)!;
    if (child.type === 'parameter_declaration') {
      // A parameter_declaration can have multiple identifiers sharing a type:
      // `func (a, b int)` → two params both typed int
      const identifiers: string[] = [];
      let paramType: string | null = null;
      for (let j = 0; j < child.childCount; j++) {
        const c = child.child(j)!;
        if (c.type === 'identifier') identifiers.push(c.text);
        else if (c.type !== ',' && c.isNamed) paramType = c.text;
      }
      for (const name of identifiers) {
        result.push({ name, type: paramType });
      }
      // Unnamed params: `func(int, string)` — no identifier, only type.
      // Use `_` as the name to avoid confusion with actual parameter names.
      if (identifiers.length === 0 && paramType) {
        result.push({ name: '_', type: paramType });
      }
    } else if (child.type === 'variadic_parameter_declaration') {
      // e.g., `args ...string` → name: "...args", type: "...string"
      const nameNode = child.children.find((c) => c.type === 'identifier');
      // Extract the type after the `...` token
      let variadicType: string | null = null;
      for (let j = 0; j < child.childCount; j++) {
        const c = child.child(j)!;
        if (c.type !== 'identifier' && c.type !== '...' && c.isNamed) {
          variadicType = `...${c.text}`;
          break;
        }
      }
      result.push({ name: `...${nameNode?.text ?? 'args'}`, type: variadicType });
    }
  }
  return result;
}

/**
 * Extract the return type from a function declaration.
 *
 * Handles both single returns (`func() string`) and multi-returns
 * (`func() (string, error)`).
 */
function extractReturnType(node: SyntaxNode): string | null {
  const isMethod = node.type === 'method_declaration';
  const paramLists = node.children.filter((c) => c.type === 'parameter_list');

  // For functions: result is after the first parameter_list.
  // For methods: result is after the second parameter_list.
  const expectedParamLists = isMethod ? 2 : 1;

  // If there's an extra parameter_list beyond expected, it's the result tuple.
  if (paramLists.length > expectedParamLists) {
    return paramLists[expectedParamLists].text;
  }

  // Single return type: look for a type_identifier or qualified_type after the params.
  const paramEndIdx = isMethod && paramLists.length >= 2
    ? node.children.indexOf(paramLists[1])
    : paramLists.length >= 1
      ? node.children.indexOf(paramLists[0])
      : -1;

  if (paramEndIdx >= 0) {
    for (let i = paramEndIdx + 1; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (c.type === 'block') break; // Body reached, no more return type
      if (c.isNamed && c.type !== 'comment') {
        return c.text;
      }
    }
  }

  return null;
}

function isInsideConditional(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'if_statement' ||
      current.type === 'for_statement' ||
      current.type === 'select_statement' ||
      current.type === 'type_switch_statement' ||
      current.type === 'expression_switch_statement'
    ) {
      return true;
    }
    if (current.type === 'function_declaration' || current.type === 'method_declaration') break;
    current = current.parent;
  }
  return false;
}
