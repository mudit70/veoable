import { Node } from 'ts-morph';
import {
  idFor,
  type ClientSideAPICaller,
  type HttpEgressConfidence,
} from '@adorable/schema';
import {
  buildEvidence,
  readStringLiteral,
  type TsFrameworkVisitor,
} from '@adorable/lang-ts';

/**
 * @google-cloud/storage visitor.
 *
 * Detects fluent-builder calls. The leaf method is what we emit on; the
 * receiver chain is walked to pull out the literal bucket and key.
 *
 *   storage.bucket('b').file('k').download()  → GET  gs://b/k
 *   storage.bucket('b').file('k').save(buf)   → PUT  gs://b/k
 *   storage.bucket('b').file('k').delete()    → DELETE gs://b/k
 *   storage.bucket('b').upload('/local')      → PUT  gs://b/
 *   storage.bucket('b').getFiles()            → GET  gs://b/
 *   storage.bucket('b').delete()              → DELETE gs://b/
 *
 * Methods like `delete`, `getMetadata`, `setMetadata`, `exists` work on
 * BOTH bucket and file. The URL scope is inferred from whether
 * `.file(...)` appears in the chain.
 *
 * Per-file gate: file must import from `@google-cloud/storage`. Without
 * this, a fluent `.bucket('...').download()` chain on a third-party
 * class would falsely match.
 */

const GCS_METHODS: ReadonlyMap<string, string> = new Map([
  // Read → GET
  ['download', 'GET'],
  ['exists', 'GET'],
  ['getMetadata', 'GET'],
  ['get', 'GET'],
  ['createReadStream', 'GET'],
  ['isPublic', 'GET'],
  ['getFiles', 'GET'],
  ['getSignedUrl', 'GET'],

  // Write → PUT/POST/PATCH
  ['save', 'PUT'],
  ['createWriteStream', 'PUT'],
  ['setMetadata', 'PATCH'],
  ['move', 'POST'],
  ['copy', 'POST'],
  ['rename', 'POST'],
  ['makePublic', 'PUT'],
  ['makePrivate', 'PUT'],
  ['upload', 'PUT'],
  ['create', 'POST'],

  // Delete
  ['delete', 'DELETE'],
]);

export function createGcsTsVisitor(): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();

  const fileImports = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === '@google-cloud/storage' || spec.startsWith('@google-cloud/storage/');
    });
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!fileImports(node, ctx.sourceFile.filePath)) return;
      if (!ctx.enclosingFunction) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const methodName = callee.getNameNode().getText();
      const httpMethod = GCS_METHODS.get(methodName);
      if (!httpMethod) return;

      const chain = walkChain(callee.getExpression());
      if (!chain.hasBucketCall) return; // Not a GCS fluent chain.

      const { urlLiteral, egressConfidence } = buildGcsUrl(chain.bucket, chain.key, chain.hasFileCall);
      const evidence = buildEvidence(node, ctx.sourceFile.filePath);
      const externalHost = chain.bucket ? `${chain.bucket}.storage.googleapis.com` : null;

      const caller: ClientSideAPICaller = {
        nodeType: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({
          sourceFileId: ctx.sourceFile.id,
          sourceLine: evidence.lineStart,
          urlLiteral,
        }),
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine: evidence.lineStart,
        httpMethod,
        urlLiteral,
        egressConfidence,
        framework: 'gcs-ts',
        repository: ctx.sourceFile.repository,
        evidence: {
          ...evidence,
          confidence: egressConfidence === 'exact' ? 'exact' : 'heuristic',
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
  hasBucketCall: boolean;
  hasFileCall: boolean;
  bucket: string | null;
  key: string | null;
}

/**
 * Walk a fluent-chain expression like
 *   storage.bucket('b').file('k')
 * Detecting `.bucket(literal?)` and `.file(literal?)` calls anywhere
 * in the receiver chain. Returns the literal arg of each (or `null` if
 * dynamic).
 */
function walkChain(start: Node): ChainResult {
  let bucket: string | null = null;
  let key: string | null = null;
  let hasBucketCall = false;
  let hasFileCall = false;
  let cursor: Node | undefined = start;

  while (cursor) {
    if (!Node.isCallExpression(cursor)) {
      if (Node.isPropertyAccessExpression(cursor)) {
        cursor = cursor.getExpression();
        continue;
      }
      break;
    }
    const inner = cursor.getExpression();
    if (!Node.isPropertyAccessExpression(inner)) break;
    const name = inner.getNameNode().getText();
    if (name === 'bucket') {
      hasBucketCall = true;
      if (bucket === null) {
        const arg = cursor.getArguments()[0];
        bucket = arg ? readStringLiteral(arg) : null;
      }
    } else if (name === 'file') {
      hasFileCall = true;
      if (key === null) {
        const arg = cursor.getArguments()[0];
        key = arg ? readStringLiteral(arg) : null;
      }
    }
    cursor = inner.getExpression();
  }

  return { hasBucketCall, hasFileCall, bucket, key };
}

function buildGcsUrl(
  bucket: string | null,
  key: string | null,
  hasFileCall: boolean,
): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (hasFileCall) {
    if (bucket && key) return { urlLiteral: `gs://${bucket}/${key}`, egressConfidence: 'exact' };
    if (bucket) return { urlLiteral: `gs://${bucket}/`, egressConfidence: 'dynamic' };
    return { urlLiteral: null, egressConfidence: 'dynamic' };
  }
  if (bucket) return { urlLiteral: `gs://${bucket}/`, egressConfidence: 'exact' };
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}
