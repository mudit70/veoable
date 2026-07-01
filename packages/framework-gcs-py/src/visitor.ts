import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideAPICaller, type HttpEgressConfidence } from '@veoable/schema';
import type { PyFrameworkVisitor } from '@veoable/lang-py';

/**
 * google-cloud-storage (Python) visitor.
 *
 * Detects fluent chains where the leaf is a known GCS verb. Walks the
 * receiver chain to find `.bucket(literal?)` and `.blob(literal?)` so
 * we can build `gs://<bucket>/<key>` URLs.
 *
 * Bucket vs file scope is inferred from the chain: if `.blob(...)`
 * appears, the URL is `gs://<bucket>/<key>`; otherwise `gs://<bucket>/`.
 * This lets `.delete()`, `.exists()`, `.reload()` work for both
 * bucket-level and blob-level operations.
 *
 * Per-file gate: `google-cloud-storage` import. Without this, a
 * fluent `.bucket('...').delete()` on an unrelated module would
 * falsely match.
 */

const GCS_METHODS: ReadonlyMap<string, string> = new Map([
  // Reads → GET
  ['download_as_text', 'GET'],
  ['download_as_string', 'GET'],
  ['download_as_bytes', 'GET'],
  ['download_to_filename', 'GET'],
  ['download_to_file', 'GET'],
  ['exists', 'GET'],
  ['reload', 'GET'],
  ['get_blob', 'GET'],
  ['list_blobs', 'GET'],
  ['list_buckets', 'GET'],
  ['generate_signed_url', 'GET'],

  // Writes → PUT/POST/PATCH
  ['upload_from_filename', 'PUT'],
  ['upload_from_string', 'PUT'],
  ['upload_from_file', 'PUT'],
  ['make_public', 'PUT'],
  ['make_private', 'PUT'],
  ['patch', 'PATCH'],
  ['update', 'PATCH'],
  ['compose', 'POST'],
  ['copy_blob', 'POST'],
  ['rename_blob', 'POST'],
  ['create_bucket', 'POST'],

  // Delete
  ['delete', 'DELETE'],
]);

export function createGcsPyVisitor(): PyFrameworkVisitor {
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

      const httpMethod = GCS_METHODS.get(attr.text);
      if (!httpMethod) return;

      const chain = walkChain(recv);
      if (!chain.hasBucketCall) return;

      if (!ctx.enclosingFunction) return;

      const { urlLiteral, egressConfidence } = buildGcsUrl(chain.bucket, chain.key, chain.hasBlobCall);

      const sourceLine = node.startPosition.row + 1;
      const snippet = node.text;
      const evidence = {
        filePath: ctx.sourceFile.filePath,
        lineStart: sourceLine,
        lineEnd: node.endPosition.row + 1,
        snippet: snippet.length <= 500 ? snippet : snippet.slice(0, 499) + '…',
        confidence: egressConfidence === 'exact' ? ('exact' as const) : ('heuristic' as const),
      };
      const externalHost = chain.bucket ? `${chain.bucket}.storage.googleapis.com` : null;

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
        framework: 'gcs-py',
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
  hasBucketCall: boolean;
  hasBlobCall: boolean;
  bucket: string | null;
  key: string | null;
}

/**
 * Walk a Python fluent chain like
 *   client.bucket("b").blob("k")
 * looking for `.bucket(literal?)` and `.blob(literal?)` calls anywhere
 * in the receiver chain. Returns the literal arg of each (or `null` if
 * dynamic).
 */
function walkChain(start: SyntaxNode): ChainResult {
  let bucket: string | null = null;
  let key: string | null = null;
  let hasBucketCall = false;
  let hasBlobCall = false;
  let cursor: SyntaxNode | null = start;

  while (cursor) {
    if (cursor.type === 'call') {
      const fn = cursor.childForFieldName('function');
      if (fn && fn.type === 'attribute') {
        const attr = fn.childForFieldName('attribute');
        if (attr) {
          const args = cursor.childForFieldName('arguments');
          if (attr.text === 'bucket' || attr.text === 'get_bucket') {
            hasBucketCall = true;
            if (bucket === null && args) bucket = firstPositionalString(args);
          } else if (attr.text === 'blob') {
            hasBlobCall = true;
            if (key === null && args) key = firstPositionalString(args);
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

  return { hasBucketCall, hasBlobCall, bucket, key };
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

function buildGcsUrl(
  bucket: string | null,
  key: string | null,
  hasBlobCall: boolean,
): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (hasBlobCall) {
    if (bucket && key) return { urlLiteral: `gs://${bucket}/${key}`, egressConfidence: 'exact' };
    if (bucket) return { urlLiteral: `gs://${bucket}/`, egressConfidence: 'dynamic' };
    return { urlLiteral: null, egressConfidence: 'dynamic' };
  }
  if (bucket) return { urlLiteral: `gs://${bucket}/`, egressConfidence: 'exact' };
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
    if (text.includes('google.cloud') && text.includes('storage')) return true;
    if (text.includes('google_cloud_storage')) return true;
  }
  return false;
}
