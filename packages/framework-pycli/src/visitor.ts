import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideProcess } from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

/**
 * Python CLI framework visitor (#62).
 *
 * Detects:
 *   1. Click/Typer CLI command decorators:
 *      @cli.command() / @app.command() / @click.command()
 *      → kind: 'cli_command'
 *
 *   2. Script entry points (non-web projects only):
 *      if __name__ == '__main__':
 *      → kind: 'script_entry'
 *
 * M1 fix: Only matches decorators where the receiver is imported from
 * click or typer (checks file imports), not arbitrary @x.command() calls.
 *
 * M2 fix: Skips __main__ detection in files importing web frameworks
 * (flask, django, fastapi) to avoid semantic noise.
 */

export function createPycliVisitor(): PyFrameworkVisitor {
  const fileImportCache = new Map<string, { hasClick: boolean; hasTyper: boolean; hasWebFramework: boolean }>();

  return {
    language: 'py',
    onNode(ctx, node) {
      const imports = getFileImports(node, ctx.sourceFile.filePath, fileImportCache);

      // ── Click/Typer CLI command decorators ────────────────────────
      if (node.type === 'decorated_definition') {
        // M1 fix: only match if click or typer is imported
        if (!imports.hasClick && !imports.hasTyper) return;

        const fnDef = node.childForFieldName('definition');
        if (!fnDef || fnDef.type !== 'function_definition') return;

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)!;
          if (child.type !== 'decorator') continue;

          const decoratorInfo = parseCliDecorator(child);
          if (!decoratorInfo) continue;

          // m3 fix: @click.group() emits as 'cli_command' only for 'command', skip 'group'
          if (decoratorInfo.kind === 'group') continue;

          const nameNode = fnDef.childForFieldName('name');
          const name = nameNode?.text ?? '<anonymous>';
          const line = fnDef.startPosition.row + 1;

          const functionId = idFor.functionDefinition({
            sourceFileId: ctx.sourceFile.id,
            name,
            sourceLine: line,
          });

          // m2 fix: framework reflects actual library
          const framework = imports.hasTyper ? 'typer' : 'click';

          const process: ClientSideProcess = {
            nodeType: 'ClientSideProcess',
            id: idFor.clientSideProcess({
              sourceFileId: ctx.sourceFile.id,
              sourceLine: child.startPosition.row + 1,
              name,
            }),
            kind: 'cli_command',
            name,
            functionId,
            sourceFileId: ctx.sourceFile.id,
            sourceLine: child.startPosition.row + 1,
            framework,
            repository: ctx.sourceFile.repository,
            evidence: {
              filePath: ctx.sourceFile.filePath,
              lineStart: child.startPosition.row + 1,
              lineEnd: fnDef.endPosition.row + 1,
              snippet: node.text.slice(0, 300),
              confidence: 'exact',
            },
          };
          ctx.emitNode(process);
          return;
        }
        return;
      }

      // ── if __name__ == '__main__' blocks ─────────────────────────
      // M2 fix: skip in web framework files (Flask/Django/FastAPI already
      // detect their own entry points via route decorators)
      if (node.type === 'if_statement') {
        if (imports.hasWebFramework) return;
        if (!isMainGuard(node)) return;

        const line = node.startPosition.row + 1;
        const functionId = ctx.enclosingFunction?.id ?? idFor.functionDefinition({
          sourceFileId: ctx.sourceFile.id,
          name: '__main__',
          sourceLine: line,
        });

        const process: ClientSideProcess = {
          nodeType: 'ClientSideProcess',
          id: idFor.clientSideProcess({
            sourceFileId: ctx.sourceFile.id,
            sourceLine: line,
            name: '__main__',
          }),
          kind: 'script_entry',
          name: '__main__',
          functionId,
          sourceFileId: ctx.sourceFile.id,
          sourceLine: line,
          framework: 'python',
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
 * Parse a CLI command decorator. Returns null if not a CLI decorator.
 * M1 fix: checks the method name is 'command' or 'group'.
 */
function parseCliDecorator(decorator: SyntaxNode): { kind: 'command' | 'group' } | null {
  for (let i = 0; i < decorator.childCount; i++) {
    const child = decorator.child(i)!;
    if (child.type === 'call') {
      const fn = child.childForFieldName('function');
      if (fn && fn.type === 'attribute') {
        const method = fn.childForFieldName('attribute');
        if (method?.text === 'command') return { kind: 'command' };
        if (method?.text === 'group') return { kind: 'group' };
      }
    }
    if (child.type === 'attribute') {
      const method = child.childForFieldName('attribute');
      if (method?.text === 'command') return { kind: 'command' };
      if (method?.text === 'group') return { kind: 'group' };
    }
  }
  return null;
}

function isMainGuard(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'comparison_operator') {
      if (child.text.includes('__name__') && child.text.includes('__main__')) {
        return true;
      }
    }
  }
  return false;
}

function getFileImports(
  node: SyntaxNode,
  filePath: string,
  cache: Map<string, { hasClick: boolean; hasTyper: boolean; hasWebFramework: boolean }>,
): { hasClick: boolean; hasTyper: boolean; hasWebFramework: boolean } {
  if (cache.has(filePath)) return cache.get(filePath)!;

  const root = node.tree.rootNode;
  let hasClick = false, hasTyper = false, hasWebFramework = false;

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === 'import_statement' || child.type === 'import_from_statement') {
      const text = child.text;
      if (text.includes('click')) hasClick = true;
      if (text.includes('typer')) hasTyper = true;
      if (text.includes('flask') || text.includes('django') || text.includes('fastapi')) {
        hasWebFramework = true;
      }
    }
  }

  const result = { hasClick, hasTyper, hasWebFramework };
  cache.set(filePath, result);
  return result;
}
