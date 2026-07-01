import type { FrameworkVisitor } from '@veoable/plugin-api';
import type { SourceFile, FunctionDefinition } from '@veoable/schema';
import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;

/**
 * Visit context passed to Python framework visitors during AST walk.
 */
export interface PyVisitContext {
  readonly sourceFile: SourceFile;
  readonly enclosingFunction: FunctionDefinition | undefined;
  readonly rootDir: string;
  readonly repository: string;
  emitNode(node: import('@veoable/schema').SchemaNode): void;
  emitEdge(edge: import('@veoable/schema').SchemaEdge): void;
}

/**
 * Python framework visitor interface. Dispatched for every AST node
 * during the tree-sitter walk.
 */
export interface PyFrameworkVisitor extends FrameworkVisitor {
  readonly language: 'py';
  onNode(ctx: PyVisitContext, node: SyntaxNode): void;
}
