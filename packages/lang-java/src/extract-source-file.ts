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
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import type { JavaFrameworkVisitor, JavaVisitContext } from './framework-visitor.js';

/**
 * Extract nodes and edges from a single Java source file using tree-sitter.
 *
 * Produces:
 *   - SourceFile node
 *   - FunctionDefinition nodes for all methods (instance + static)
 *   - DEFINED_IN edges (FunctionDefinition → SourceFile)
 *   - EXPORTS edges for public/protected methods and interface methods
 *   - CALLS_FUNCTION edges for method invocations
 *
 * Java-specific considerations:
 *   - Visibility via access modifiers: `public`/`protected` = exported
 *   - Interface methods are implicitly public
 *   - Methods always belong to a class/interface/enum: `ClassName.methodName`
 *   - Constructors: `ClassName.constructor`
 *   - Enums and records are supported alongside classes/interfaces
 *   - Annotations: dispatched to framework visitors (Spring, JPA detection)
 *   - Static methods: `isAsync: false` (Java has no async/await)
 *
 * Two-pass extraction within class bodies:
 *   Unlike lang-go and lang-py, Java methods routinely call helpers defined
 *   later in the same class. To handle this, each class/interface/enum body
 *   is processed in two passes: (1) collect all method signatures into
 *   `fnByName`, (2) walk method bodies for call resolution. This ensures
 *   forward references within a class are resolved correctly.
 *
 * Known limitation — overloaded methods:
 *   Java allows multiple methods with the same name but different parameter
 *   types. `fnByName` is keyed by `ClassName.methodName` without arity
 *   distinction, so later overloads overwrite earlier ones. This means call
 *   edges may resolve to the wrong overload. A future improvement could
 *   append arity (e.g., `ClassName.method/2`).
 *
 * TODO: Java import resolution — currently dispatches import_declaration
 *   nodes to visitors but does not emit IMPORTS edges. Resolving Java
 *   imports requires understanding package paths, classpath, and Maven/
 *   Gradle dependency resolution.
 */
export function extractJavaFile(
  tree: Tree,
  filePath: string,
  repository: string,
  rootDir: string,
  visitors: JavaFrameworkVisitor[]
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
    language: 'java',
    framework: null,
  };
  nodes.push(sourceFile);

  const fnByName = new Map<string, FunctionDefinition>();
  const functionStack: FunctionDefinition[] = [];

  const visitCtx: JavaVisitContext = {
    sourceFile,
    get enclosingFunction() { return functionStack[functionStack.length - 1]; },
    rootDir,
    repository,
    emitNode(n) { nodes.push(n); },
    emitEdge(e) { edges.push(e); },
  };

  /**
   * Determine if a method is exported based on modifiers and context.
   * - `public` and `protected` are exported (part of the API surface)
   * - Interface methods are implicitly public
   */
  function isMethodExported(modifiers: Set<string>, isInInterface: boolean): boolean {
    if (modifiers.has('public') || modifiers.has('protected')) return true;
    if (isInInterface && !modifiers.has('private')) return true;
    return false;
  }

  /**
   * Register a method or constructor as a FunctionDefinition in the graph.
   */
  function registerMethod(
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
   * Two-pass class body processing (M1 fix):
   * Pass 1: Register all method/constructor signatures into fnByName.
   * Pass 2: Walk method bodies for call resolution and visitor dispatch.
   */
  function processClassBody(
    body: SyntaxNode,
    fullClassName: string,
    isInterface: boolean,
  ): void {
    // Structures to hold method info for the two-pass approach.
    interface MethodInfo {
      node: SyntaxNode;
      fnDef: FunctionDefinition;
      bodyNode: SyntaxNode | null;
    }
    const methods: MethodInfo[] = [];

    // ── Pass 1: Collect all method/constructor signatures ───────────
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i)!;

      if (child.type === 'method_declaration') {
        const nameNode = child.childForFieldName('name');
        const methodName = nameNode?.text ?? '<anonymous>';
        const fullName = `${fullClassName}.${methodName}`;
        const line = child.startPosition.row + 1;
        const modifiers = extractModifiers(child);
        const exported = isMethodExported(modifiers, isInterface);
        const params = extractParameters(child);
        const returnType = extractReturnType(child);

        const fnDef = registerMethod(fullName, child, line, exported, params, returnType, methodName);
        methods.push({ node: child, fnDef, bodyNode: child.childForFieldName('body') });
      } else if (child.type === 'constructor_declaration') {
        const ctorName = `${fullClassName}.constructor`;
        const line = child.startPosition.row + 1;
        const modifiers = extractModifiers(child);
        const exported = isMethodExported(modifiers, false);
        const params = extractParameters(child);

        const fnDef = registerMethod(ctorName, child, line, exported, params, null, 'constructor');
        methods.push({ node: child, fnDef, bodyNode: child.childForFieldName('body') });
      } else if (
        child.type === 'class_declaration' ||
        child.type === 'interface_declaration' ||
        child.type === 'enum_declaration' ||
        child.type === 'record_declaration'
      ) {
        // Nested type — recurse with full class name
        walk(child, fullClassName);
      }
    }

    // ── Pass 2: Walk method bodies for calls and visitor dispatch ───
    for (const { node, fnDef, bodyNode } of methods) {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);

      if (bodyNode) {
        functionStack.push(fnDef);
        walkChildren(bodyNode, fullClassName);
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

    // ── Enum declarations (M4 fix) ────────────────────────────────
    if (node.type === 'enum_declaration') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);

      const nameNode = node.childForFieldName('name');
      const enumName = nameNode?.text ?? '<anonymous>';
      const fullEnumName = className ? `${className}.${enumName}` : enumName;
      const body = node.childForFieldName('body');
      if (body) {
        // Enum bodies have methods inside `enum_body_declarations`
        // (after the enum constants and semicolon).
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i)!;
          if (child.type === 'enum_body_declarations') {
            processClassBody(child, fullEnumName, false);
          }
        }
      }
      return;
    }

    // ── Record declarations (m1 fix, Java 16+) ────────────────────
    if (node.type === 'record_declaration') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);

      const nameNode = node.childForFieldName('name');
      const recName = nameNode?.text ?? '<anonymous>';
      const fullRecName = className ? `${className}.${recName}` : recName;
      const body = node.childForFieldName('body');
      if (body) processClassBody(body, fullRecName, false);
      return;
    }

    // ── Import declarations ────────────────────────────────────────
    // TODO: Java import resolution — see JSDoc above.
    if (node.type === 'import_declaration') {
      for (const visitor of visitors) visitor.onNode(visitCtx, node);
      return;
    }

    // ── Method invocations ─────────────────────────────────────────
    if (node.type === 'method_invocation') {
      extractCall(node, className);
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

  function extractCall(node: SyntaxNode, className: string | null): void {
    const enclosing = functionStack[functionStack.length - 1];
    if (!enclosing) return;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const methodName = nameNode.text;

    const objectNode = node.childForFieldName('object');
    let calleeName: string | null = null;
    let confidence: 'direct' | 'method' | 'indirect' | 'dynamic' = 'dynamic';

    if (objectNode) {
      const objText = objectNode.text;
      // M3 fix: `this.method()` and `super.method()` resolve to ClassName.method
      if ((objText === 'this' || objText === 'super') && className) {
        calleeName = `${className}.${methodName}`;
        confidence = 'direct';
      } else {
        // obj.method() → try as ClassName.method
        calleeName = `${objText}.${methodName}`;
        confidence = 'method';
      }
    } else {
      // Unqualified call: method() → try ClassName.method (same class)
      if (className) {
        calleeName = `${className}.${methodName}`;
        confidence = 'direct';
      } else {
        calleeName = methodName;
        confidence = 'direct';
      }
    }

    let targetId: string | null = null;
    if (calleeName) {
      const target = fnByName.get(calleeName);
      if (target) {
        targetId = target.id;
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

  walk(tree.rootNode, null);

  return { nodes, edges };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Known Java modifier keywords. Used for robust extraction that doesn't
 * depend on tree-sitter's isNamed flag for keyword nodes (M2 fix).
 */
const MODIFIER_KEYWORDS = new Set([
  'public', 'private', 'protected', 'static', 'final',
  'abstract', 'synchronized', 'native', 'transient', 'volatile',
  'default', 'strictfp', 'sealed', 'non-sealed',
]);

/**
 * Extract access modifiers from a method or class declaration.
 * Uses an explicit keyword set instead of relying on isNamed to be
 * robust against tree-sitter grammar updates (M2 fix).
 */
function extractModifiers(node: SyntaxNode): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'modifiers') {
      for (let j = 0; j < child.childCount; j++) {
        const mod = child.child(j)!;
        // Skip annotation nodes — they are not access modifiers.
        if (mod.type === 'marker_annotation' || mod.type === 'annotation') continue;
        // Match against known modifier keywords by text content.
        if (MODIFIER_KEYWORDS.has(mod.text)) {
          result.add(mod.text);
        }
      }
    }
  }
  return result;
}

/**
 * Extract parameters from a method or constructor declaration.
 */
function extractParameters(node: SyntaxNode): Array<{ name: string; type: string | null }> {
  const paramsNode = node.childForFieldName('parameters');
  if (!paramsNode) return [];

  const result: Array<{ name: string; type: string | null }> = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i)!;
    if (child.type === 'formal_parameter') {
      const nameNode = child.childForFieldName('name');
      const name = nameNode?.text ?? '_';

      let paramType: string | null = null;
      for (let j = 0; j < child.childCount; j++) {
        const c = child.child(j)!;
        if (c === nameNode) continue;
        if (c.type === 'modifiers') continue;
        if (c.isNamed) {
          paramType = c.text;
          break;
        }
      }

      result.push({ name, type: paramType });
    } else if (child.type === 'spread_parameter') {
      // Varargs: `String... items` → name from variable_declarator child
      let varName = '_';
      let paramType: string | null = null;
      for (let j = 0; j < child.childCount; j++) {
        const c = child.child(j)!;
        if (c.type === 'variable_declarator') {
          varName = c.text;
        } else if (c.type !== '...' && c.isNamed) {
          paramType = c.text;
        }
      }
      result.push({ name: `...${varName}`, type: paramType });
    }
  }
  return result;
}

/**
 * Extract the return type from a method declaration.
 * Java methods always declare a return type (or void).
 *
 * tree-sitter-java places the return type as a direct child of
 * method_declaration, between modifiers and the method name.
 * Handles void, primitives, generics (`List<String>`), and arrays.
 */
function extractReturnType(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'modifiers') continue;
    // Skip generic type_parameters like `<T>` before return type
    if (child.type === 'type_parameters') continue;
    if (child === nameNode) break;
    if (child.isNamed) return child.text;
    if (child.type === 'void_type') return 'void';
  }
  return null;
}

function isInsideConditional(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'if_statement' ||
      current.type === 'for_statement' ||
      current.type === 'enhanced_for_statement' ||
      current.type === 'while_statement' ||
      current.type === 'do_statement' ||
      current.type === 'try_statement' ||
      current.type === 'catch_clause' ||
      current.type === 'switch_expression' ||
      current.type === 'switch_statement' ||  // m6 fix
      current.type === 'ternary_expression'
    ) {
      return true;
    }
    if (current.type === 'method_declaration' || current.type === 'constructor_declaration') break;
    current = current.parent;
  }
  return false;
}
