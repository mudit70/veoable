import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type DatabaseInteraction } from '@veoable/schema';
import type { JavaFrameworkVisitor, JavaVisitContext } from '@veoable/lang-java';

/**
 * JPA/Hibernate framework visitor (#51).
 *
 * Detects database interactions from Spring Data JPA repository method calls:
 *   repository.findAll()       → read
 *   repository.findById(id)    → read
 *   repository.findByEmail(e)  → read
 *   repository.save(entity)    → write
 *   repository.deleteById(id)  → delete
 *   repository.count()         → read
 *   repository.existsById(id)  → read
 *
 * Detection heuristic: method calls on receivers ending in "Repository"
 * or "Repo", with method names matching JPA conventions.
 *
 * M4 fix: Also checks for Spring/JPA imports at the file level to reduce
 * false positives in non-Spring Java projects.
 *
 * Known limitation: targetTableId is a best-effort placeholder derived
 * from the receiver name. Real table resolution requires entity→table
 * mapping from JPA annotations (@Entity, @Table).
 */

const READ_METHODS = /^(find|get|count|exists|query|search|read)/;
const WRITE_METHODS = /^(save|create|insert|update|put|merge|persist)/;
const DELETE_METHODS = /^(delete|remove)/;

export function createJpaVisitor(): JavaFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();

  return {
    language: 'java',
    onNode(ctx, node) {
      if (node.type !== 'method_invocation') return;
      if (!ctx.enclosingFunction) return;

      // M4 fix: file-level import guard
      if (!fileImportsSpringOrJpa(node, ctx.sourceFile.filePath, fileImportCache)) return;

      const objectNode = node.childForFieldName('object');
      const nameNode = node.childForFieldName('name');
      if (!objectNode || !nameNode) return;

      const receiverText = objectNode.text;
      const methodName = nameNode.text;

      // Heuristic: receiver ends with Repository or Repo
      if (!receiverText.match(/[Rr]epo(sitory)?$/)) return;

      let operation: 'read' | 'write' | 'delete' | 'raw';
      if (READ_METHODS.test(methodName)) {
        operation = 'read';
      } else if (WRITE_METHODS.test(methodName)) {
        operation = 'write';
      } else if (DELETE_METHODS.test(methodName)) {
        operation = 'delete';
      } else {
        return;
      }

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: `table:${receiverText}`,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'jpa',
        rawQuery: null,
        confidence: 'inferred',
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          snippet: node.text.slice(0, 200),
          confidence: 'heuristic',
        },
      };
      ctx.emitNode(interaction);
    },
  };
}

/**
 * M4 fix: Check if the source file imports from Spring or JPA packages.
 * This prevents false positives on non-Spring Java projects where
 * variables happen to end in "Repository".
 */
function fileImportsSpringOrJpa(node: SyntaxNode, filePath: string, cache: Map<string, boolean>): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const root = node.tree.rootNode;
  let has = false;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === 'import_declaration') {
      const text = child.text;
      if (text.includes('springframework') || text.includes('javax.persistence') ||
          text.includes('jakarta.persistence') || text.includes('hibernate')) {
        has = true;
        break;
      }
    }
  }
  cache.set(filePath, has);
  return has;
}
