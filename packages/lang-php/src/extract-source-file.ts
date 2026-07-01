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
import type { PhpFrameworkVisitor, PhpVisitContext } from './framework-visitor.js';

/**
 * Extract nodes and edges from a single PHP source file using tree-sitter.
 *
 * Produces:
 *   - SourceFile node
 *   - FunctionDefinition nodes for all functions and methods
 *   - DEFINED_IN edges (FunctionDefinition → SourceFile)
 *   - EXPORTS edges for public/protected methods and top-level functions
 *   - CALLS_FUNCTION edges for function, member, and scoped calls
 *
 * PHP-specific considerations:
 *   - Mix of procedural (top-level functions) and OOP (class methods)
 *   - Visibility via `public`, `private`, `protected` modifiers
 *   - Top-level functions are always exported
 *   - Interface methods are implicitly public
 *   - `$this->method()` calls resolve to `ClassName.method`
 *   - `self::method()`, `static::method()`, `parent::method()` resolve
 *     to `ClassName.method` (scoped call expressions)
 *   - Traits are handled like classes for method extraction
 *   - Constructors: `__construct` → `ClassName.constructor`
 *   - Anonymous classes: methods extracted as `<anonymous>.methodName`
 *   - PHP 8 constructor property promotion parameters supported
 *
 * Two-pass extraction within class bodies:
 *   Each class/interface/trait body is processed in two passes:
 *   (1) collect method signatures, (2) walk bodies for call resolution.
 *   This handles forward references within a class.
 *
 * Known limitation — namespace prefix:
 *   Class names do not include the namespace prefix (e.g., `UserService`
 *   instead of `App\Services\UserService`). This may cause collisions
 *   when multiple namespaces define classes with the same name.
 *
 * TODO: PHP import resolution — `namespace_use_declaration` nodes are
 *   dispatched to visitors but do not emit IMPORTS edges. Resolving
 *   PHP imports requires understanding PSR-4 autoloading, composer
 *   autoload mappings, and namespace-to-file-path resolution.
 */
export function extractPhpFile(
  tree: Tree,
  filePath: string,
  repository: string,
  rootDir: string,
  visitors: PhpFrameworkVisitor[]
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
    language: 'php',
    framework: null,
  };
  nodes.push(sourceFile);

  const fnByName = new Map<string, FunctionDefinition>();
  const functionStack: FunctionDefinition[] = [];

  const visitCtx: PhpVisitContext = {
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
      isAsync: false,
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
   * Two-pass class body processing.
   */
  function processClassBody(
    body: SyntaxNode,
    className: string,
    isInterface: boolean,
  ): void {
    interface MethodInfo {
      node: SyntaxNode;
      fnDef: FunctionDefinition;
      bodyNode: SyntaxNode | null;
    }
    const methods: MethodInfo[] = [];

    // Pass 1: collect method signatures
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i)!;

      if (child.type === 'method_declaration') {
        const nameNode = child.childForFieldName('name');
        const methodName = nameNode?.text ?? '<anonymous>';
        const displayName = methodName === '__construct' ? 'constructor' : methodName;
        const fullName = `${className}.${displayName}`;
        const line = child.startPosition.row + 1;
        const visibility = extractVisibility(child);
        const exported = isMethodExported(visibility, isInterface);
        const params = extractParameters(child);
        const returnType = extractReturnType(child);

        const fnDef = registerFunction(fullName, child, line, exported, params, returnType, displayName);
        methods.push({ node: child, fnDef, bodyNode: child.childForFieldName('body') });
      } else if (
        child.type === 'class_declaration' ||
        child.type === 'interface_declaration' ||
        child.type === 'trait_declaration'
      ) {
        walk(child, className);
      }
    }

    // Pass 2: walk method bodies
    for (const { node, fnDef, bodyNode } of methods) {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);

      if (bodyNode) {
        functionStack.push(fnDef);
        walkChildren(bodyNode, className);
        functionStack.pop();
      }
    }
  }

  function walk(node: SyntaxNode, className: string | null): void {
    // ── Class declarations ─────────────────────────────────────────
    if (node.type === 'class_declaration') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);

      const nameNode = node.childForFieldName('name');
      const clsName = nameNode?.text ?? '<anonymous>';
      const fullClassName = className ? `${className}.${clsName}` : clsName;
      const body = node.childForFieldName('body');
      if (body) processClassBody(body, fullClassName, false);
      return;
    }

    // ── Interface declarations ─────────────────────────────────────
    if (node.type === 'interface_declaration') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);

      const nameNode = node.childForFieldName('name');
      const ifaceName = nameNode?.text ?? '<anonymous>';
      const fullIfaceName = className ? `${className}.${ifaceName}` : ifaceName;
      const body = node.childForFieldName('body');
      if (body) processClassBody(body, fullIfaceName, true);
      return;
    }

    // ── Trait declarations ─────────────────────────────────────────
    if (node.type === 'trait_declaration') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);

      const nameNode = node.childForFieldName('name');
      const traitName = nameNode?.text ?? '<anonymous>';
      const fullTraitName = className ? `${className}.${traitName}` : traitName;
      const body = node.childForFieldName('body');
      if (body) processClassBody(body, fullTraitName, false);
      return;
    }

    // ── Anonymous class expressions (M3 fix) ──────────────────────
    if (node.type === 'object_creation_expression') {
      // Check for anonymous class: `new class { ... }`
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === 'declaration_list') {
          processClassBody(child, '<anonymous>', false);
        }
      }
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      walkChildren(node, className);
      return;
    }

    // ── Top-level function definitions ─────────────────────────────
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text ?? '<anonymous>';
      const line = node.startPosition.row + 1;
      const params = extractParameters(node);
      const returnType = extractReturnType(node);

      const fnDef = registerFunction(name, node, line, true, params, returnType, name);

      for (const visitor of visitors) visitor.onNode(visitCtx, node);

      functionStack.push(fnDef);
      const body = node.childForFieldName('body');
      if (body) walkChildren(body, className);
      functionStack.pop();
      return;
    }

    // ── Namespace use declarations (imports) ───────────────────────
    // TODO: PHP import resolution — see JSDoc above.
    if (node.type === 'namespace_use_declaration') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      return;
    }

    // ── Function call expressions ──────────────────────────────────
    if (node.type === 'function_call_expression') {
      extractFunctionCall(node);
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      walkChildren(node, className);
      return;
    }

    // ── Member call expressions: $obj->method() ────────────────────
    if (node.type === 'member_call_expression') {
      extractMemberCall(node, className);
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      walkChildren(node, className);
      return;
    }

    // ── Scoped call expressions: self::method(), static::, parent:: (M1 fix) ─
    if (node.type === 'scoped_call_expression') {
      extractScopedCall(node, className);
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      walkChildren(node, className);
      return;
    }

    // ── All other nodes: dispatch + recurse ────────────────────────
    for (const visitor of visitors) visitor.onNode(visitCtx, node);
    walkChildren(node, className);
  }

  function walkChildren(node: SyntaxNode, className: string | null): void {
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, className);
    }
  }

  function extractFunctionCall(node: SyntaxNode): void {
    const enclosing = functionStack[functionStack.length - 1];
    if (!enclosing) return;

    const fnNode = node.childForFieldName('function');
    if (!fnNode) return;
    const calleeName = fnNode.text;
    if (!calleeName) return;

    const target = fnByName.get(calleeName);
    if (!target) return;

    edges.push({
      edgeType: 'CALLS_FUNCTION',
      from: enclosing.id,
      to: target.id,
      sourceLine: node.startPosition.row + 1,
      arguments: extractArgTexts(node.childForFieldName('arguments')),
      isConditional: isInsideConditional(node),
      confidence: 'direct',
    } as CallsFunctionEdge);
  }

  // M2 fix: Only handle $this->method() here. self/static/parent use :: not ->.
  function extractMemberCall(node: SyntaxNode, className: string | null): void {
    const enclosing = functionStack[functionStack.length - 1];
    if (!enclosing) return;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const methodName = nameNode.text;

    const objectNode = node.childForFieldName('object');
    let calleeName: string | null = null;
    let confidence: 'direct' | 'method' = 'method';

    if (objectNode) {
      const objText = objectNode.text;
      // $this->method() → resolve to ClassName.method
      if (objText === '$this' && className) {
        calleeName = `${className}.${methodName}`;
        confidence = 'direct';
      } else {
        calleeName = `${objText}.${methodName}`;
      }
    }

    if (!calleeName) return;
    const target = fnByName.get(calleeName);
    if (!target) return;

    edges.push({
      edgeType: 'CALLS_FUNCTION',
      from: enclosing.id,
      to: target.id,
      sourceLine: node.startPosition.row + 1,
      arguments: extractArgTexts(node.childForFieldName('arguments')),
      isConditional: isInsideConditional(node),
      confidence,
    } as CallsFunctionEdge);
  }

  // M1 fix: Handle self::method(), static::method(), parent::method()
  function extractScopedCall(node: SyntaxNode, className: string | null): void {
    const enclosing = functionStack[functionStack.length - 1];
    if (!enclosing) return;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    let methodName = nameNode.text;

    // Normalize __construct to constructor
    if (methodName === '__construct') methodName = 'constructor';

    const scopeNode = node.childForFieldName('scope');
    if (!scopeNode) return;
    const scopeText = scopeNode.text;

    let calleeName: string | null = null;
    let confidence: 'direct' | 'method' = 'method';

    if ((scopeText === 'self' || scopeText === 'static' || scopeText === 'parent') && className) {
      // Resolve to current class for self/static, parent would need
      // class hierarchy info which we don't have. Use current class as best effort.
      calleeName = `${className}.${methodName}`;
      confidence = 'direct';
    } else {
      // ClassName::method() — static method call on a named class
      calleeName = `${scopeText}.${methodName}`;
    }

    if (!calleeName) return;
    const target = fnByName.get(calleeName);
    if (!target) return;

    edges.push({
      edgeType: 'CALLS_FUNCTION',
      from: enclosing.id,
      to: target.id,
      sourceLine: node.startPosition.row + 1,
      arguments: extractArgTexts(node.childForFieldName('arguments')),
      isConditional: isInsideConditional(node),
      confidence,
    } as CallsFunctionEdge);
  }

  function extractArgTexts(args: SyntaxNode | null): string[] {
    if (!args) return [];
    const result: string[] = [];
    for (let i = 0; i < args.childCount; i++) {
      const child = args.child(i)!;
      if (child.type !== '(' && child.type !== ')' && child.type !== ',') {
        result.push(child.text.slice(0, 80));
      }
    }
    return result.slice(0, 5);
  }

  walk(tree.rootNode, null);

  return { nodes, edges };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function extractVisibility(node: SyntaxNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'visibility_modifier') {
      return child.text;
    }
  }
  return null;
}

function isMethodExported(visibility: string | null, isInterface: boolean): boolean {
  if (visibility === 'public' || visibility === 'protected') return true;
  if (isInterface && visibility !== 'private') return true;
  return false;
}

/** Known PHP parameter type node types for explicit matching (m4 fix). */
const PARAM_TYPE_NODES = new Set([
  'primitive_type', 'named_type', 'optional_type', 'nullable_type',
  'union_type', 'intersection_type',
]);

/**
 * Extract parameters from a function or method declaration.
 * Handles simple_parameter, variadic_parameter, and
 * property_promotion_parameter (PHP 8, m2 fix).
 */
function extractParameters(node: SyntaxNode): Array<{ name: string; type: string | null }> {
  const paramsNode = node.childForFieldName('parameters');
  if (!paramsNode) return [];

  const result: Array<{ name: string; type: string | null }> = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i)!;

    if (child.type === 'simple_parameter' || child.type === 'property_promotion_parameter') {
      let name = '_';
      let paramType: string | null = null;

      for (let j = 0; j < child.childCount; j++) {
        const c = child.child(j)!;
        if (c.type === 'variable_name') {
          name = c.text.startsWith('$') ? c.text.slice(1) : c.text;
        } else if (PARAM_TYPE_NODES.has(c.type)) {
          paramType = c.text;
        }
      }
      result.push({ name, type: paramType });
    } else if (child.type === 'variadic_parameter') {
      let name = 'args';
      let paramType: string | null = null;
      for (let j = 0; j < child.childCount; j++) {
        const c = child.child(j)!;
        if (c.type === 'variable_name') {
          name = c.text.startsWith('$') ? c.text.slice(1) : c.text;
        } else if (PARAM_TYPE_NODES.has(c.type)) {
          paramType = c.text;
        }
      }
      result.push({ name: `...${name}`, type: paramType });
    }
  }
  return result;
}

/**
 * Extract return type from a function or method declaration (m3 fix).
 *
 * Uses position-based search: finds the type node between the formal_parameters
 * and compound_statement, after the `:` separator.
 */
function extractReturnType(node: SyntaxNode): string | null {
  const paramsNode = node.childForFieldName('parameters');
  if (!paramsNode) return null;

  const paramsIdx = node.children.indexOf(paramsNode);
  let foundColon = false;

  // Only search children AFTER the parameters node
  for (let i = paramsIdx + 1; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'compound_statement') break;
    if (child.type === ':') {
      foundColon = true;
      continue;
    }
    if (foundColon && child.isNamed) {
      return child.text;
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
      current.type === 'foreach_statement' ||
      current.type === 'while_statement' ||
      current.type === 'do_statement' ||
      current.type === 'try_statement' ||
      current.type === 'catch_clause' ||
      current.type === 'switch_statement' ||
      current.type === 'match_expression'
    ) {
      return true;
    }
    if (current.type === 'method_declaration' || current.type === 'function_definition') break;
    current = current.parent;
  }
  return false;
}
