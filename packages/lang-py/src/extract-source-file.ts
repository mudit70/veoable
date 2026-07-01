import * as fs from 'node:fs';
import * as path from 'node:path';
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
  type ImportsEdge,
  type CallsFunctionEdge,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import type { PyFrameworkVisitor, PyVisitContext } from './framework-visitor.js';

/**
 * Extract nodes and edges from a single Python source file using tree-sitter.
 *
 * Produces:
 *   - SourceFile node
 *   - FunctionDefinition nodes for all def/async def (top-level + methods)
 *   - DEFINED_IN edges
 *   - EXPORTS edges for top-level functions (Python: all module-level are "exported")
 *   - IMPORTS edges for import/from-import statements
 *   - CALLS_FUNCTION edges for function calls
 */
export function extractPythonFile(
  tree: Tree,
  filePath: string,
  repository: string,
  rootDir: string,
  visitors: PyFrameworkVisitor[]
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
    language: 'python',
    framework: null,
  };
  nodes.push(sourceFile);

  // Track functions by tree-sitter node ID for call resolution.
  const fnByNodeId = new Map<number, FunctionDefinition>();
  const fnByName = new Map<string, FunctionDefinition>();
  const functionStack: FunctionDefinition[] = [];

  // Visit context for framework visitors.
  const visitCtx: PyVisitContext = {
    sourceFile,
    get enclosingFunction() { return functionStack[functionStack.length - 1]; },
    rootDir,
    repository,
    emitNode(n) { nodes.push(n); },
    emitEdge(e) { edges.push(e); },
  };

  // Recursive AST walk.
  function walk(node: SyntaxNode, className: string | null): void {
    // Detect function definitions.
    if (node.type === 'function_definition' || node.type === 'decorated_definition') {
      const fnNode = node.type === 'decorated_definition'
        ? node.childForFieldName('definition')
        : node;
      if (!fnNode || (fnNode.type !== 'function_definition')) {
        // Decorated class — skip function handling, walk children.
        for (const child of node.children) walk(child, className);
        return;
      }

      const nameNode = fnNode.childForFieldName('name');
      const name = nameNode?.text ?? '<anonymous>';
      const fullName = className ? `${className}.${name}` : name;
      const line = fnNode.startPosition.row + 1;

      const fnDef: FunctionDefinition = {
        nodeType: 'FunctionDefinition',
        id: idFor.functionDefinition({ sourceFileId, name: fullName, sourceLine: line }),
        name: fullName,
        sourceFileId,
        sourceLine: line,
        parameters: extractParameters(fnNode),
        returnType: extractReturnType(fnNode),
        isExported: className === null, // Module-level = exported in Python
        isAsync: fnNode.children.some((c) => c.type === 'async')
          || node.children.some((c) => c.type === 'async'),
      };
      nodes.push(fnDef);
      edges.push({ edgeType: 'DEFINED_IN', from: fnDef.id, to: sourceFileId } as DefinedInEdge);
      fnByNodeId.set(fnNode.id, fnDef);
      fnByName.set(fullName, fnDef);

      if (fnDef.isExported) {
        edges.push({
          edgeType: 'EXPORTS',
          from: sourceFileId,
          to: fnDef.id,
          exportName: name,
          isDefault: false,
        } as ExportsEdge);
      }

      // Dispatch framework visitors.
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }

      // Walk body with this function on the stack.
      functionStack.push(fnDef);
      const body = fnNode.childForFieldName('body');
      if (body) {
        for (const child of body.children) walk(child, className);
      }
      functionStack.pop();
      return;
    }

    // Detect class definitions.
    if (node.type === 'class_definition') {
      // Dispatch to visitors for the class node (Django ViewSet detection).
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }
      const nameNode = node.childForFieldName('name');
      const clsName = nameNode?.text ?? '<anonymous>';
      const body = node.childForFieldName('body');
      if (body) {
        for (const child of body.children) walk(child, clsName);
      }
      return;
    }

    // Detect imports.
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      extractImport(node, sourceFileId, posixPath, edges);
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }
      return;
    }

    // Detect function calls — dispatch to visitors, then fall through
    // to recurse into children (for nested calls like foo(bar())).
    if (node.type === 'call') {
      extractCall(node, functionStack, fnByName, sourceFileId, edges);
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }
    } else {
      // All other node types — dispatch to visitors.
      for (const visitor of visitors) {
        visitor.onNode(visitCtx, node);
      }
    }

    // Recurse into children.
    for (const child of node.children) {
      walk(child, className);
    }
  }

  walk(tree.rootNode, null);

  return { nodes, edges };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function extractParameters(fnNode: SyntaxNode): Array<{ name: string; type: string | null }> {
  const params = fnNode.childForFieldName('parameters');
  if (!params) return [];
  const result: Array<{ name: string; type: string | null }> = [];
  for (const child of params.children) {
    if (child.type === 'identifier') {
      const name = child.text;
      if (name !== 'self' && name !== 'cls') {
        result.push({ name, type: null });
      }
    } else if (child.type === 'typed_parameter') {
      const name = child.children[0]?.text ?? '';
      const typeNode = child.childForFieldName('type');
      if (name !== 'self' && name !== 'cls') {
        result.push({ name, type: typeNode?.text ?? null });
      }
    } else if (child.type === 'default_parameter' || child.type === 'typed_default_parameter') {
      const name = child.childForFieldName('name')?.text ?? child.children[0]?.text ?? '';
      if (name !== 'self' && name !== 'cls') {
        result.push({ name, type: null });
      }
    } else if (child.type === 'list_splat_pattern') {
      // *args
      const name = child.children.find((c) => c.type === 'identifier')?.text ?? 'args';
      result.push({ name: `*${name}`, type: null });
    } else if (child.type === 'dictionary_splat_pattern') {
      // **kwargs
      const name = child.children.find((c) => c.type === 'identifier')?.text ?? 'kwargs';
      result.push({ name: `**${name}`, type: null });
    }
  }
  return result;
}

function extractReturnType(fnNode: SyntaxNode): string | null {
  const returnType = fnNode.childForFieldName('return_type');
  return returnType?.text ?? null;
}

// TODO: Python import resolution (#142) — currently a no-op.
// Emitting IMPORTS edges requires resolving module names to file paths,
// which needs knowledge of the Python import system (sys.path, __init__.py,
// relative imports, installed packages). For now, imports are parsed but
// not emitted. Cross-file call resolution relies on name matching instead.
function extractImport(
  node: SyntaxNode,
  sourceFileId: string,
  filePath: string,
  edges: SchemaEdge[]
): void {
  if (node.type === 'import_statement') {
    for (const child of node.children) {
      if (child.type === 'dotted_name') {
        // Can't resolve to a SourceFile without knowing the project layout,
        // so we record the module name as a placeholder.
        // Future: resolve relative imports to actual file paths.
      }
    }
    return;
  }

  if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name');
    const moduleName = moduleNode?.text;
    if (!moduleName) return;

    const symbols: string[] = [];
    for (const child of node.children) {
      if (child.type === 'dotted_name' && child !== moduleNode) {
        symbols.push(child.text);
      } else if (child.type === 'aliased_import') {
        const name = child.childForFieldName('name');
        if (name) symbols.push(name.text);
      }
    }
    // For relative imports (starting with .), try to resolve to a file.
    // For now, record as a named import without target resolution.
  }
}

function extractCall(
  node: SyntaxNode,
  functionStack: FunctionDefinition[],
  fnByName: Map<string, FunctionDefinition>,
  sourceFileId: string,
  edges: SchemaEdge[]
): void {
  const enclosing = functionStack[functionStack.length - 1];
  if (!enclosing) return;

  const callee = node.childForFieldName('function');
  if (!callee) return;

  let calleeName: string | null = null;
  let confidence: 'direct' | 'method' | 'indirect' | 'dynamic' = 'dynamic';

  if (callee.type === 'identifier') {
    calleeName = callee.text;
    confidence = 'direct';
  } else if (callee.type === 'attribute') {
    // obj.method() → method call
    const attr = callee.childForFieldName('attribute');
    const obj = callee.childForFieldName('object');
    if (attr && obj) {
      calleeName = `${obj.text}.${attr.text}`;
      confidence = 'method';
    }
  }

  // Try to resolve the callee to a known function.
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
      for (const child of args.children) {
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

function isInsideConditional(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'if_statement' ||
      current.type === 'while_statement' ||
      current.type === 'for_statement' ||
      current.type === 'try_statement' ||
      current.type === 'except_clause' ||
      current.type === 'conditional_expression'
    ) {
      return true;
    }
    if (current.type === 'function_definition') break;
    current = current.parent;
  }
  return false;
}
