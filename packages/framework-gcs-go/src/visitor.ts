import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideAPICaller, type HttpEgressConfidence } from '@veoable/schema';
import type { GoFrameworkVisitor } from '@veoable/lang-go';

/**
 * cloud.google.com/go/storage visitor.
 *
 * Detects fluent chains. The leaf method (in GCS_METHODS) triggers
 * emit; the receiver chain is walked to find `.Bucket(literal?)` and
 * `.Object(literal?)` calls so we can build `gs://<bucket>/<key>`
 * URLs.
 *
 * Bucket vs object scope is inferred from chain content — so
 * `.Delete(ctx)` and `.Attrs(ctx)` work for both bucket-level and
 * object-level operations.
 *
 * Per-file gate: `cloud.google.com/go/storage` import. Without it, a
 * fluent `.Bucket("...").Delete(ctx)` chain on an unrelated package
 * would falsely match.
 */

const GCS_METHODS: ReadonlyMap<string, string> = new Map([
  // Reads → GET
  ['NewReader', 'GET'],
  ['NewRangeReader', 'GET'],
  ['Attrs', 'GET'],
  ['Objects', 'GET'],
  ['SignedURL', 'GET'],
  ['ReadAll', 'GET'],

  // Writes → PUT/POST/PATCH
  ['NewWriter', 'PUT'],
  ['Update', 'PATCH'],
  ['CopierFrom', 'POST'],
  ['ComposerFrom', 'POST'],
  ['Run', 'POST'], // Copier.Run / Composer.Run — best-effort POST
  ['Create', 'POST'],
  ['ACL', 'PUT'],

  // Delete
  ['Delete', 'DELETE'],
]);

export function createGcsGoVisitor(): GoFrameworkVisitor {
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
      const operand = fn.childForFieldName('operand');
      if (!field || !operand) return;

      const httpMethod = GCS_METHODS.get(field.text);
      if (!httpMethod) return;

      const chain = walkChain(operand);
      if (!chain.hasBucketCall) return;

      if (!ctx.enclosingFunction) return;

      const { urlLiteral, egressConfidence } = buildGcsUrl(chain.bucket, chain.key, chain.hasObjectCall);
      const sourceLine = node.startPosition.row + 1;
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
        framework: 'gcs-go',
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
  hasBucketCall: boolean;
  hasObjectCall: boolean;
  bucket: string | null;
  key: string | null;
}

/**
 * Walk a Go fluent chain like
 *   client.Bucket("b").Object("k")
 * looking for `.Bucket(literal?)` and `.Object(literal?)` calls
 * anywhere in the receiver chain. Returns the literal arg of each (or
 * `null` if dynamic).
 *
 * tree-sitter-go: a method call is a `call_expression` whose
 *   `function` = `selector_expression { operand, field }`. For chained
 *   calls, the `operand` is another `call_expression`.
 */
function walkChain(start: SyntaxNode): ChainResult {
  let bucket: string | null = null;
  let key: string | null = null;
  let hasBucketCall = false;
  let hasObjectCall = false;
  let cursor: SyntaxNode | null = start;

  while (cursor) {
    if (cursor.type === 'call_expression') {
      const fn = cursor.childForFieldName('function');
      if (fn && fn.type === 'selector_expression') {
        const field = fn.childForFieldName('field');
        if (field) {
          const args = cursor.childForFieldName('arguments');
          if (field.text === 'Bucket') {
            hasBucketCall = true;
            if (bucket === null && args) bucket = firstPositionalString(args);
          } else if (field.text === 'Object') {
            hasObjectCall = true;
            if (key === null && args) key = firstPositionalString(args);
          }
        }
        cursor = fn.childForFieldName('operand');
        continue;
      }
      break;
    }
    if (cursor.type === 'selector_expression') {
      cursor = cursor.childForFieldName('operand');
      continue;
    }
    break;
  }

  return { hasBucketCall, hasObjectCall, bucket, key };
}

function firstPositionalString(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
      return stripGoString(c.text);
    }
    return null;
  }
  return null;
}

function stripGoString(text: string): string {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function buildGcsUrl(
  bucket: string | null,
  key: string | null,
  hasObjectCall: boolean,
): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (hasObjectCall) {
    if (bucket && key) return { urlLiteral: `gs://${bucket}/${key}`, egressConfidence: 'exact' };
    if (bucket) return { urlLiteral: `gs://${bucket}/`, egressConfidence: 'dynamic' };
    return { urlLiteral: null, egressConfidence: 'dynamic' };
  }
  if (bucket) return { urlLiteral: `gs://${bucket}/`, egressConfidence: 'exact' };
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_declaration') continue;
    if (c.text.includes('cloud.google.com/go/storage')) return true;
  }
  return false;
}
