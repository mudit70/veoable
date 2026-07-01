import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideAPICaller, type HttpEgressConfidence } from '@veoable/schema';
import type { GoFrameworkVisitor } from '@veoable/lang-go';

/**
 * azblob (Go) visitor.
 *
 * Detects positional-arg client calls. The modern top-level azblob
 * client takes (ctx, container, blob, …) for object ops and
 * (ctx, container, …) for container ops.
 *
 * The verb determines which positional indices to read AND the HTTP
 * verb to stamp. `takesBlob` gates whether the URL is
 * `azure://<container>/<blob>` vs `azure://<container>/`.
 *
 * Per-file gate: `azblob` import (text match on
 * `azure-sdk-for-go/sdk/storage/azblob`).
 */

interface VerbInfo {
  method: string;
  takesBlob: boolean;
}

const AZURE_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Reads (object) → GET
  ['DownloadStream', { method: 'GET', takesBlob: true }],
  ['DownloadBuffer', { method: 'GET', takesBlob: true }],
  ['DownloadFile', { method: 'GET', takesBlob: true }],

  // Writes (object) → PUT
  ['UploadStream', { method: 'PUT', takesBlob: true }],
  ['UploadBuffer', { method: 'PUT', takesBlob: true }],
  ['UploadFile', { method: 'PUT', takesBlob: true }],
  ['CopyFromURL', { method: 'PUT', takesBlob: true }],

  // Delete (object)
  ['DeleteBlob', { method: 'DELETE', takesBlob: true }],

  // Container-scope
  ['CreateContainer', { method: 'PUT', takesBlob: false }],
  ['DeleteContainer', { method: 'DELETE', takesBlob: false }],
  ['NewListBlobsFlatPager', { method: 'GET', takesBlob: false }],
  ['NewListContainersPager', { method: 'GET', takesBlob: false }],
]);

export function createAzureBlobGoVisitor(): GoFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = scanFileImports(root);
    importsByFile.set(filePath, value);
    return value;
  };

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'selector_expression') return;
      const field = fn.childForFieldName('field');
      if (!field) return;

      const verb = AZURE_VERBS.get(field.text);
      if (!verb) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      if (!args) return;
      // Index 0 = ctx, Index 1 = container, Index 2 = blob.
      const container = stringArgAt(args, 1);
      const blob = verb.takesBlob ? stringArgAt(args, 2) : null;

      const { urlLiteral, egressConfidence } = buildAzureUrl(container, blob, verb.takesBlob);

      const sourceLine = node.startPosition.row + 1;
      const externalHost = container ? `${container}.blob.core.windows.net` : null;

      const caller: ClientSideAPICaller = {
        nodeType: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({
          sourceFileId: ctx.sourceFile.id,
          sourceLine,
          urlLiteral,
        }),
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine,
        httpMethod: verb.method,
        urlLiteral,
        egressConfidence,
        framework: 'azure-blob-go',
        repository: ctx.sourceFile.repository,
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: sourceLine,
          lineEnd: node.endPosition.row + 1,
          snippet: node.text.slice(0, 200),
          confidence: egressConfidence === 'exact' ? ('exact' as const) : ('heuristic' as const),
        },
        ...(urlLiteral ? { isExternal: true, externalHost } : {}),
      };
      ctx.emitNode(caller);
      ctx.emitEdge({
        edgeType: 'MAKES_REQUEST',
        from: ctx.enclosingFunction.id,
        to: caller.id,
      });
    },
  };
}

function stringArgAt(args: SyntaxNode, idx: number): string | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === idx) {
      if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
        return stripGoString(c.text);
      }
      return null;
    }
    seen++;
  }
  return null;
}

function stripGoString(text: string): string {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function buildAzureUrl(
  container: string | null,
  blob: string | null,
  takesBlob: boolean,
): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (takesBlob) {
    if (container && blob) return { urlLiteral: `azure://${container}/${blob}`, egressConfidence: 'exact' };
    if (container) return { urlLiteral: `azure://${container}/`, egressConfidence: 'dynamic' };
    return { urlLiteral: null, egressConfidence: 'dynamic' };
  }
  if (container) return { urlLiteral: `azure://${container}/`, egressConfidence: 'exact' };
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_declaration') continue;
    if (c.text.includes('azure-sdk-for-go/sdk/storage/azblob')) return true;
  }
  return false;
}
