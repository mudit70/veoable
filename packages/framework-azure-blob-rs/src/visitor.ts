import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideAPICaller, type HttpEgressConfidence } from '@adorable/schema';
import { hasCrateImport, type RustFrameworkVisitor } from '@adorable/lang-rust';

/**
 * azure_storage_blobs (Rust) visitor.
 *
 * Detects fluent chains. Leaf method (in AZURE_METHODS) triggers
 * emit; receiver chain is walked to find `.container_client(literal?)`
 * and `.blob_client(literal?)`.
 *
 * Container vs blob scope inferred from `.blob_client(...)` presence
 * in chain.
 *
 * Per-file gate: `use azure_storage_blobs` (or `azure-storage-blobs`).
 */

const AZURE_METHODS: ReadonlyMap<string, string> = new Map([
  // Reads → GET
  ['get', 'GET'],
  ['get_properties', 'GET'],
  ['get_metadata', 'GET'],
  ['get_tags', 'GET'],
  ['exists', 'GET'],
  ['list_blobs', 'GET'],
  ['list_containers', 'GET'],
  ['stream', 'GET'],

  // Writes → PUT
  ['put_block_blob', 'PUT'],
  ['put_append_blob', 'PUT'],
  ['put_page_blob', 'PUT'],
  ['put_block', 'PUT'],
  ['put_block_list', 'PUT'],
  ['append_block', 'PUT'],
  ['copy', 'PUT'],
  ['copy_from_url', 'PUT'],
  ['set_metadata', 'PUT'],
  ['set_tags', 'PUT'],
  ['set_properties', 'PUT'],
  ['set_blob_tier', 'PUT'],
  ['create', 'PUT'],
  ['create_if_not_exists', 'PUT'],

  // Delete
  ['delete', 'DELETE'],
]);

export function createAzureBlobRsVisitor(): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v =
      hasCrateImport(root, 'azure_storage_blobs') ||
      hasCrateImport(root, 'azure-storage-blobs');
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'field_expression') return;
      const field = fn.childForFieldName('field');
      if (!field) return;

      const httpMethod = AZURE_METHODS.get(field.text);
      if (!httpMethod) return;

      const operand = fn.childForFieldName('value');
      if (!operand) return;
      const chain = walkChain(operand);
      if (!chain.hasContainerCall) return;

      if (!ctx.enclosingFunction) return;

      const { urlLiteral, egressConfidence } = buildAzureUrl(
        chain.container,
        chain.blob,
        chain.hasBlobCall,
      );
      const sourceLine = node.startPosition.row + 1;
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
        framework: 'azure-blob-rs',
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
    if (cursor.type === 'call_expression') {
      const fn = cursor.childForFieldName('function');
      if (fn && fn.type === 'field_expression') {
        const field = fn.childForFieldName('field');
        if (field) {
          const args = cursor.childForFieldName('arguments');
          if (field.text === 'container_client') {
            hasContainerCall = true;
            if (container === null && args) container = firstStringArg(args);
          } else if (field.text === 'blob_client') {
            hasBlobCall = true;
            if (blob === null && args) blob = firstStringArg(args);
          }
        }
        cursor = fn.childForFieldName('value');
        continue;
      }
      break;
    }
    if (cursor.type === 'field_expression') {
      cursor = cursor.childForFieldName('value');
      continue;
    }
    break;
  }

  return { hasContainerCall, hasBlobCall, container, blob };
}

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'string_literal' || c.type === 'raw_string_literal') {
      return stripRustString(c.text);
    }
    return null;
  }
  return null;
}

function stripRustString(text: string): string | null {
  let s = text;
  if (s.startsWith('b') || s.startsWith('B')) s = s.slice(1);
  if (s.startsWith('r')) {
    const hashes = /^r(#*)"/.exec(s);
    if (hashes) {
      const h = hashes[1].length;
      const closer = '"' + '#'.repeat(h);
      const start = 1 + h + 1;
      if (s.endsWith(closer)) return s.slice(start, s.length - closer.length);
    }
    return null;
  }
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
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
