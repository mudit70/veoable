import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideProcess } from '@adorable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';

/**
 * Go CLI framework visitor (#62).
 *
 * Detects:
 *   1. Cobra Command definitions:
 *      var listCmd = &cobra.Command{ Use: "list", Run: func(...) { ... } }
 *      → kind: 'cli_command', name from "Use" field
 *
 *   2. main() function entry points:
 *      func main() { ... }
 *      → kind: 'script_entry'
 *
 * Only detects Cobra commands in files importing spf13/cobra.
 * main() detection works in all Go files.
 */

export function createGocliVisitor(): GoFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();

  return {
    language: 'go',
    onNode(ctx, node) {
      // ── Cobra Command composite literals ─────────────────────────
      if (node.type === 'composite_literal') {
        if (!fileImportsCobra(node, ctx.sourceFile.filePath, fileImportCache)) return;

        const typeNode = node.childForFieldName('type');
        if (!typeNode) return;
        if (!typeNode.text.includes('cobra.Command')) return;

        // Extract the Use field value as the command name
        const cmdName = extractFieldValue(node, 'Use');
        if (!cmdName) return;

        // m4 fix: skip root commands without a Run handler — they're
        // containers, not actual command handlers
        if (!hasRunField(node)) return;

        const line = node.startPosition.row + 1;

        // Find the enclosing variable name (var listCmd = ...)
        const varName = findEnclosingVarName(node);
        const functionId = ctx.enclosingFunction?.id ?? idFor.functionDefinition({
          sourceFileId: ctx.sourceFile.id,
          name: varName ?? cmdName,
          sourceLine: line,
        });

        const process: ClientSideProcess = {
          nodeType: 'ClientSideProcess',
          id: idFor.clientSideProcess({
            sourceFileId: ctx.sourceFile.id,
            sourceLine: line,
            name: cmdName,
          }),
          kind: 'cli_command',
          name: cmdName,
          functionId,
          sourceFileId: ctx.sourceFile.id,
          sourceLine: line,
          framework: 'cobra',
          repository: ctx.sourceFile.repository,
          evidence: {
            filePath: ctx.sourceFile.filePath,
            lineStart: line,
            lineEnd: node.endPosition.row + 1,
            snippet: node.text.slice(0, 300),
            confidence: 'exact',
          },
        };
        ctx.emitNode(process);
        return;
      }

      // ── main() function entry point ──────────────────────────────
      // M2 fix: Only emit for files importing cobra (CLI apps), not web servers
      if (node.type === 'function_declaration') {
        if (!fileImportsCobra(node, ctx.sourceFile.filePath, fileImportCache)) return;
        const nameNode = node.childForFieldName('name');
        if (!nameNode || nameNode.text !== 'main') return;

        const line = node.startPosition.row + 1;
        const functionId = idFor.functionDefinition({
          sourceFileId: ctx.sourceFile.id,
          name: 'main',
          sourceLine: line,
        });

        const process: ClientSideProcess = {
          nodeType: 'ClientSideProcess',
          id: idFor.clientSideProcess({
            sourceFileId: ctx.sourceFile.id,
            sourceLine: line,
            name: 'main',
          }),
          kind: 'script_entry',
          name: 'main',
          functionId,
          sourceFileId: ctx.sourceFile.id,
          sourceLine: line,
          framework: 'go',
          repository: ctx.sourceFile.repository,
          evidence: {
            filePath: ctx.sourceFile.filePath,
            lineStart: line,
            lineEnd: node.endPosition.row + 1,
            snippet: node.text.slice(0, 200),
            confidence: 'exact',
          },
        };
        ctx.emitNode(process);
      }
    },
  };
}

/**
 * Extract a string field value from a Go composite literal.
 * { Use: "list", ... } → returns "list" for field "Use"
 */
function extractFieldValue(compositeLit: SyntaxNode, fieldName: string): string | null {
  const body = compositeLit.childForFieldName('body');
  if (!body) return null;

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i)!;
    if (child.type === 'keyed_element') {
      // Key can be field_identifier or literal_element depending on grammar
      const key = child.children.find((c) =>
        c.type === 'field_identifier' || c.type === 'literal_element'
      );
      if (key && key.text === fieldName) {
        // Value: string literal or literal_element containing quoted string
        for (const c of child.children) {
          if (c === key) continue;
          if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
            return c.text.slice(1, -1);
          }
          if (c.type === 'literal_element' && (c.text.startsWith('"') || c.text.startsWith('`'))) {
            return c.text.slice(1, -1);
          }
        }
      }
    }
  }
  return null;
}

/** Check if a cobra.Command composite literal has a Run or RunE field. */
function hasRunField(compositeLit: SyntaxNode): boolean {
  const body = compositeLit.childForFieldName('body');
  if (!body) return false;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i)!;
    if (child.type === 'keyed_element') {
      const key = child.children.find((c) =>
        c.type === 'field_identifier' || c.type === 'literal_element'
      );
      if (key && (key.text === 'Run' || key.text === 'RunE')) return true;
    }
  }
  return false;
}

function findEnclosingVarName(node: SyntaxNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'var_spec') {
      const name = current.childForFieldName('name');
      if (name) return name.text;
    }
    if (current.type === 'short_var_declaration') {
      const left = current.childForFieldName('left');
      if (left) return left.text;
    }
    current = current.parent;
  }
  return null;
}

function fileImportsCobra(node: SyntaxNode, filePath: string, cache: Map<string, boolean>): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const root = node.tree.rootNode;
  let has = false;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === 'import_declaration' && child.text.includes('spf13/cobra')) {
      has = true;
      break;
    }
  }
  cache.set(filePath, has);
  return has;
}
