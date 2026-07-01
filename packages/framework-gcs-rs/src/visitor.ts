import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideAPICaller, type HttpEgressConfidence } from '@veoable/schema';
import { hasCrateImport, type RustFrameworkVisitor } from '@veoable/lang-rust';

/**
 * google-cloud-storage (Rust) visitor.
 *
 * Detection: `<client>.<verb>(&<RequestStruct>{ bucket: "...", object: "...", .. }, ...)`.
 * The leaf method maps 1:1 to an HTTP verb. Bucket and object are
 * extracted from struct-field literals by walking the call's args text
 * (text-based extraction mirrors framework-awsrust-s3 — robust against
 * tree-sitter-rust grammar version drift).
 *
 * Methods like `delete_object` operate on objects (have `object:` field
 * in the request); `delete_bucket` operates on buckets only. We
 * derive scope from whether `object:` is present in the matched
 * request text.
 *
 * Per-file gate: `use google_cloud_storage` (or `google-cloud-storage`).
 * Without this, a fluent `.put_object(...)` on an unrelated crate
 * would falsely match.
 */

interface VerbInfo {
  method: string;
  /** Whether this verb takes an object field (and therefore can produce a key URL). */
  takesObject: boolean;
}

const GCS_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Object reads → GET
  ['download_object', { method: 'GET', takesObject: true }],
  ['download_streamed_object', { method: 'GET', takesObject: true }],
  ['get_object', { method: 'GET', takesObject: true }],
  ['list_objects', { method: 'GET', takesObject: false }],

  // Object writes → PUT/POST/PATCH
  ['upload_object', { method: 'PUT', takesObject: true }],
  ['upload_streamed_object', { method: 'PUT', takesObject: true }],
  ['patch_object', { method: 'PATCH', takesObject: true }],
  ['update_object', { method: 'PATCH', takesObject: true }],
  ['copy_object', { method: 'POST', takesObject: true }],
  ['rewrite_object', { method: 'POST', takesObject: true }],
  ['compose_object', { method: 'POST', takesObject: true }],

  // Object delete
  ['delete_object', { method: 'DELETE', takesObject: true }],

  // Bucket-level → GET/POST/PATCH/DELETE
  ['list_buckets', { method: 'GET', takesObject: false }],
  ['get_bucket', { method: 'GET', takesObject: false }],
  ['insert_bucket', { method: 'POST', takesObject: false }],
  ['create_bucket', { method: 'POST', takesObject: false }],
  ['patch_bucket', { method: 'PATCH', takesObject: false }],
  ['update_bucket', { method: 'PATCH', takesObject: false }],
  ['delete_bucket', { method: 'DELETE', takesObject: false }],
]);

export function createGcsRsVisitor(): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = hasCrateImport(root, 'google_cloud_storage') || hasCrateImport(root, 'google-cloud-storage');
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

      const verb = GCS_VERBS.get(field.text);
      if (!verb) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      if (!args) return;
      const argsText = args.text;
      const bucket = extractStructFieldLiteral(argsText, 'bucket');
      const key = verb.takesObject ? extractStructFieldLiteral(argsText, 'object') : null;

      const { urlLiteral, egressConfidence } = buildGcsUrl(bucket, key, verb.takesObject);

      const sourceLine = node.startPosition.row + 1;
      const externalHost = bucket ? `${bucket}.storage.googleapis.com` : null;

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
        framework: 'gcs-rs',
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

function buildGcsUrl(
  bucket: string | null,
  key: string | null,
  takesObject: boolean,
): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (takesObject) {
    if (bucket && key) return { urlLiteral: `gs://${bucket}/${key}`, egressConfidence: 'exact' };
    if (bucket) return { urlLiteral: `gs://${bucket}/`, egressConfidence: 'dynamic' };
    return { urlLiteral: null, egressConfidence: 'dynamic' };
  }
  if (bucket) return { urlLiteral: `gs://${bucket}/`, egressConfidence: 'exact' };
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

/**
 * Extract `<field>: "literal".to_string()` or `<field>: "literal".into()`
 * or `<field>: "literal".to_owned()` or `<field>: String::from("literal")`
 * from a Rust struct-literal source string. Returns null when the RHS
 * is an identifier or any non-literal expression.
 */
function extractStructFieldLiteral(text: string, field: string): string | null {
  // Bare string literal: bucket: "name"
  const bare = new RegExp(`\\b${field}\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`);
  const bm = bare.exec(text);
  if (bm) {
    // Disambiguate: ensure it's not `String::from("x")` (handled below)
    return bm[1].replace(/\\"/g, '"');
  }
  // String::from("name")
  const stringFrom = new RegExp(`\\b${field}\\s*:\\s*String::from\\(\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*\\)`);
  const sm = stringFrom.exec(text);
  if (sm) return sm[1].replace(/\\"/g, '"');
  return null;
}
