import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideAPICaller, type HttpEgressConfidence } from '@veoable/schema';
import type { PyFrameworkVisitor } from '@veoable/lang-py';

/**
 * azure-storage-blob (Python) visitor.
 *
 * Detects fluent chains where the leaf is a known Azure Blob operation.
 * The receiver chain is walked to find `.get_container_client(literal?)`
 * and `.get_blob_client(literal?)` so we can build
 * `azure://<container>/<blob>` URLs.
 *
 * Container vs blob scope is inferred from `.get_blob_client(...)`
 * presence in chain.
 *
 * Per-file gate: `azure.storage.blob` import.
 */

const AZURE_METHODS: ReadonlyMap<string, string> = new Map([
  // Reads → GET
  ['download_blob', 'GET'],
  ['get_blob_properties', 'GET'],
  ['get_blob_tags', 'GET'],
  ['get_container_properties', 'GET'],
  ['exists', 'GET'],
  ['list_blobs', 'GET'],
  ['list_blob_names', 'GET'],
  ['list_containers', 'GET'],
  ['walk_blobs', 'GET'],

  // Writes → PUT
  ['upload_blob', 'PUT'],
  ['upload_blob_from_url', 'PUT'],
  ['stage_block', 'PUT'],
  ['stage_block_from_url', 'PUT'],
  ['commit_block_list', 'PUT'],
  ['create_container', 'PUT'],
  ['create_page_blob', 'PUT'],
  ['create_append_blob', 'PUT'],
  ['append_block', 'PUT'],
  ['append_block_from_url', 'PUT'],
  ['set_blob_metadata', 'PUT'],
  ['set_container_metadata', 'PUT'],
  ['set_blob_tags', 'PUT'],
  ['set_http_headers', 'PUT'],
  ['set_standard_blob_tier', 'PUT'],
  ['start_copy_from_url', 'PUT'],

  // Delete
  ['delete_blob', 'DELETE'],
  ['delete_container', 'DELETE'],
  ['delete_blobs', 'DELETE'],
]);

export function createAzureBlobPyVisitor(): PyFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = scanFileImports(root);
    importsByFile.set(filePath, value);
    return value;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') return;
      const attr = fn.childForFieldName('attribute');
      const recv = fn.childForFieldName('object');
      if (!attr || !recv) return;

      const httpMethod = AZURE_METHODS.get(attr.text);
      if (!httpMethod) return;

      const chain = walkChain(recv);
      if (!chain.hasContainerCall) return;

      if (!ctx.enclosingFunction) return;

      const { urlLiteral, egressConfidence } = buildAzureUrl(chain.container, chain.blob, chain.hasBlobCall);
      const sourceLine = node.startPosition.row + 1;
      const snippet = node.text;
      const evidence = {
        filePath: ctx.sourceFile.filePath,
        lineStart: sourceLine,
        lineEnd: node.endPosition.row + 1,
        snippet: snippet.length <= 500 ? snippet : snippet.slice(0, 499) + '…',
        confidence: egressConfidence === 'exact' ? ('exact' as const) : ('heuristic' as const),
      };
      const externalHost = chain.container ? `${chain.container}.blob.core.windows.net` : null;

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
        httpMethod,
        urlLiteral,
        egressConfidence,
        framework: 'azure-blob-py',
        repository: ctx.sourceFile.repository,
        evidence,
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

interface ChainResult {
  hasContainerCall: boolean;
  hasBlobCall: boolean;
  container: string | null;
  blob: string | null;
}

function walkChain(start: SyntaxNode): ChainResult {
  let container: string | null = null;
  let blob: string | null = null;
  let hasContainerCall = false;
  let hasBlobCall = false;
  let cursor: SyntaxNode | null = start;

  while (cursor) {
    if (cursor.type === 'call') {
      const fn = cursor.childForFieldName('function');
      if (fn && fn.type === 'attribute') {
        const attr = fn.childForFieldName('attribute');
        if (attr) {
          const args = cursor.childForFieldName('arguments');
          if (attr.text === 'get_container_client') {
            hasContainerCall = true;
            if (container === null && args) container = firstPositionalString(args);
          } else if (attr.text === 'get_blob_client') {
            hasBlobCall = true;
            if (blob === null && args) blob = firstPositionalString(args);
          }
        }
        cursor = fn.childForFieldName('object');
        continue;
      }
      break;
    }
    if (cursor.type === 'attribute') {
      cursor = cursor.childForFieldName('object');
      continue;
    }
    break;
  }

  return { hasContainerCall, hasBlobCall, container, blob };
}

function firstPositionalString(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    return extractPythonStringValue(c);
  }
  return null;
}

function buildAzureUrl(
  container: string | null,
  blob: string | null,
  hasBlobCall: boolean,
): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (hasBlobCall) {
    if (container && blob) return { urlLiteral: `azure://${container}/${blob}`, egressConfidence: 'exact' };
    if (container) return { urlLiteral: `azure://${container}/`, egressConfidence: 'dynamic' };
    return { urlLiteral: null, egressConfidence: 'dynamic' };
  }
  if (container) return { urlLiteral: `azure://${container}/`, egressConfidence: 'exact' };
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

function extractPythonStringValue(node: SyntaxNode): string | null {
  if (node.type === 'string') return stripPythonString(node.text);
  if (node.type === 'concatenated_string') {
    let combined = '';
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c || c.type !== 'string') return null;
      const lit = stripPythonString(c.text);
      if (lit === null) return null;
      combined += lit;
    }
    return combined.length > 0 ? combined : null;
  }
  return null;
}

function stripPythonString(text: string): string | null {
  let s = text;
  if (/^[rRbBuU]*[fF]/.test(s)) return null;
  s = s.replace(/^[rRbBuU]+/, '');
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return null;
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
    const text = c.text;
    if (text.includes('azure.storage.blob')) return true;
    if (text.includes('azure_storage_blob')) return true;
  }
  return false;
}
