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
 * @azure/storage-blob visitor.
 *
 * Detects fluent calls where the leaf is a known Azure Blob operation.
 * The receiver chain is walked to find `.getContainerClient(literal?)`
 * and `.getBlobClient(literal?)` / `.getBlockBlobClient(literal?)` /
 * `.getAppendBlobClient(literal?)` / `.getPageBlobClient(literal?)`
 * so we can build `azure://<container>/<blob>` URLs.
 *
 * Container vs blob scope is inferred from the chain: if any of the
 * `get*BlobClient(...)` calls appear, the URL is
 * `azure://<container>/<blob>`; otherwise `azure://<container>/`. This
 * lets `delete()`, `exists()`, `getProperties()` work for both
 * container-level and blob-level operations.
 *
 * Per-file gate: file must import from `@azure/storage-blob`.
 */

const AZURE_METHODS: ReadonlyMap<string, string> = new Map([
  // Reads → GET
  ['download', 'GET'],
  ['downloadToBuffer', 'GET'],
  ['downloadToFile', 'GET'],
  ['exists', 'GET'],
  ['getProperties', 'GET'],
  ['getMetadata', 'GET'],
  ['getTags', 'GET'],
  ['listBlobsFlat', 'GET'],
  ['listBlobsByHierarchy', 'GET'],
  ['listContainers', 'GET'],
  ['generateSasUrl', 'GET'],

  // Writes → PUT/PATCH
  ['upload', 'PUT'],
  ['uploadData', 'PUT'],
  ['uploadFile', 'PUT'],
  ['uploadStream', 'PUT'],
  ['uploadBlockBlob', 'PUT'],
  ['stageBlock', 'PUT'],
  ['commitBlockList', 'PUT'],
  ['create', 'PUT'],
  ['createIfNotExists', 'PUT'],
  ['appendBlock', 'PUT'],
  ['setHTTPHeaders', 'PUT'],
  ['setMetadata', 'PUT'],
  ['setTags', 'PUT'],
  ['setAccessTier', 'PUT'],
  ['setTier', 'PUT'],
  ['syncCopyFromURL', 'PUT'],
  ['beginCopyFromURL', 'PUT'],

  // Delete
  ['delete', 'DELETE'],
  ['deleteIfExists', 'DELETE'],
]);

const BLOB_GETTER_NAMES = new Set([
  'getBlobClient',
  'getBlockBlobClient',
  'getAppendBlobClient',
  'getPageBlobClient',
]);

export function createAzureBlobTsVisitor(): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();

  const fileImports = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === '@azure/storage-blob' || spec.startsWith('@azure/storage-blob/');
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
      const httpMethod = AZURE_METHODS.get(methodName);
      if (!httpMethod) return;

      const chain = walkChain(callee.getExpression());
      if (!chain.hasContainerCall) return;

      const { urlLiteral, egressConfidence } = buildAzureUrl(
        chain.container,
        chain.blob,
        chain.hasBlobCall,
      );
      const evidence = buildEvidence(node, ctx.sourceFile.filePath);
      const externalHost = chain.container ? `${chain.container}.blob.core.windows.net` : null;

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
        framework: 'azure-blob-ts',
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
  hasContainerCall: boolean;
  hasBlobCall: boolean;
  container: string | null;
  blob: string | null;
}

/**
 * Walk a fluent chain like
 *   svc.getContainerClient("c").getBlockBlobClient("k")
 * Detecting `.getContainerClient(literal?)` and
 * `.get(Block|Append|Page|)BlobClient(literal?)` calls anywhere in the
 * receiver chain. Returns the literal arg of each (or `null` if dynamic).
 */
function walkChain(start: Node): ChainResult {
  let container: string | null = null;
  let blob: string | null = null;
  let hasContainerCall = false;
  let hasBlobCall = false;
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
    if (name === 'getContainerClient') {
      hasContainerCall = true;
      if (container === null) {
        const arg = cursor.getArguments()[0];
        container = arg ? readStringLiteral(arg) : null;
      }
    } else if (BLOB_GETTER_NAMES.has(name)) {
      hasBlobCall = true;
      if (blob === null) {
        const arg = cursor.getArguments()[0];
        blob = arg ? readStringLiteral(arg) : null;
      }
    }
    cursor = inner.getExpression();
  }

  return { hasContainerCall, hasBlobCall, container, blob };
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
