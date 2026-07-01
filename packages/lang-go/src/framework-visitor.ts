import type { FrameworkVisitor } from '@adorable/plugin-api';
import type { SourceFile, FunctionDefinition } from '@adorable/schema';
import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;

/**
 * Visit context passed to Go framework visitors during AST walk.
 */
export interface GoVisitContext {
  readonly sourceFile: SourceFile;
  readonly enclosingFunction: FunctionDefinition | undefined;
  readonly rootDir: string;
  readonly repository: string;
  emitNode(node: import('@adorable/schema').SchemaNode): void;
  emitEdge(edge: import('@adorable/schema').SchemaEdge): void;
}

/**
 * Go framework visitor interface. Dispatched for every AST node
 * during the tree-sitter walk.
 */
export interface GoFrameworkVisitor extends FrameworkVisitor {
  readonly language: 'go';
  onNode(ctx: GoVisitContext, node: SyntaxNode): void;
}
