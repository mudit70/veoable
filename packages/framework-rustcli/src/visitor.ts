import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideProcess } from '@adorable/schema';
import type { RustFrameworkVisitor, RustVisitContext } from '@adorable/lang-rust';

/**
 * Rust CLI/desktop framework visitor (#62).
 *
 * Detects:
 *   1. Tauri commands:
 *      #[tauri::command] async fn get_users() -> Vec<User> {}
 *      → kind: 'bridge_command'
 *
 *   2. main() function entry points (only in clap/tauri files):
 *      fn main() { ... }
 *      → kind: 'script_entry'
 *
 * M2 fix: main() detection only fires for files using CLI frameworks
 * (clap or tauri), not web servers (actix/axum/rocket).
 */

export function createRustcliVisitor(): RustFrameworkVisitor {
  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'function_item') return;

      // ── Tauri #[tauri::command] attributes ──────────────────────
      const tauriAttr = findTauriCommandAttribute(node);
      if (tauriAttr) {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text ?? '<anonymous>';
        const line = node.startPosition.row + 1;

        const functionId = idFor.functionDefinition({
          sourceFileId: ctx.sourceFile.id,
          name,
          sourceLine: line,
        });

        const process: ClientSideProcess = {
          nodeType: 'ClientSideProcess',
          id: idFor.clientSideProcess({
            sourceFileId: ctx.sourceFile.id,
            sourceLine: tauriAttr.startPosition.row + 1,
            name,
          }),
          kind: 'bridge_command',
          name,
          functionId,
          sourceFileId: ctx.sourceFile.id,
          sourceLine: tauriAttr.startPosition.row + 1,
          framework: 'tauri',
          repository: ctx.sourceFile.repository,
          evidence: {
            filePath: ctx.sourceFile.filePath,
            lineStart: tauriAttr.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            snippet: (tauriAttr.text + '\n' + node.text).slice(0, 300),
            confidence: 'exact',
          },
        };
        ctx.emitNode(process);
        return;
      }

      // ── main() function entry point ─────────────────────────────
      // M2 fix: only emit for files using clap/tauri, not web servers
      const nameNode = node.childForFieldName('name');
      if (nameNode && nameNode.text === 'main' && fileUsesCliFramework(node)) {
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
          framework: 'rust',
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
 * Find a #[tauri::command] attribute preceding a function item.
 */
function findTauriCommandAttribute(fnNode: SyntaxNode): SyntaxNode | null {
  let current = fnNode.previousNamedSibling;
  while (current && current.type === 'attribute_item') {
    const attr = current.children.find((c) => c.type === 'attribute');
    if (attr) {
      const attrText = attr.text;
      if (attrText.includes('tauri::command') || attrText.includes('tauri :: command')) {
        return current;
      }
    }
    current = current.previousNamedSibling;
  }
  return null;
}

/**
 * M2 fix: Check if the file uses clap or tauri (CLI frameworks).
 */
function fileUsesCliFramework(node: SyntaxNode): boolean {
  const root = node.tree.rootNode;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === 'use_declaration') {
      const text = child.text;
      if (text.includes('clap') || text.includes('tauri')) return true;
    }
  }
  return false;
}
