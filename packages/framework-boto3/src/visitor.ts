import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type ClientSideAPICaller,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseSystem,
  type DatabaseTable,
  type HttpEgressConfidence,
} from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

/**
 * boto3 visitor.
 *
 * Covers S3, DynamoDB, SQS, SNS, and Lambda. Each service has its own
 * verb map, framework label, and URL convention; emits share the
 * caller-only ClientSideAPICaller shape so the flow stitcher treats
 * them uniformly.
 *
 *   S3:        s3://<bucket>/<key>          framework=boto3-s3        method=verb-specific
 *   DynamoDB:  dynamodb://<TableName>/      framework=boto3-dynamodb  method=verb-specific
 *   SQS:       sqs:<QueueUrl-tail>          framework=boto3-sqs       method=JOB
 *   SNS:       sns:<TopicArn-tail>          framework=boto3-sns       method=JOB
 *   Lambda:    lambda:<FunctionName>        framework=boto3-lambda    method=POST
 *
 * Activation: `boto3` / `aioboto3` in any Python manifest.
 */

type ServiceId = 's3' | 'dynamodb' | 'sqs' | 'sns' | 'lambda';

interface VerbInfo {
  service: ServiceId;
  method: string;
}

/**
 * DynamoDB verbs that ALSO produce DatabaseInteraction nodes
 * alongside the ClientSideAPICaller (Fix 4 of the test-apps
 * scorecard, mirror of the awsrust-s3 / awsgo-s3 / aws-s3-ts
 * emission). DDB is the only AWS service in this plugin that's
 * semantically a database. Control-plane verbs intentionally
 * don't emit DBIs — they aren't row-level interactions.
 */
const DDB_VERB_TO_DB_OP: ReadonlyMap<string, DatabaseOperation> = new Map([
  ['get_item', 'read'],
  ['query', 'read'],
  ['scan', 'read'],
  // put_item REPLACES any existing item with the same primary key —
  // semantically an upsert, not a strict insert. See
  // framework-awsrust-s3 for the same rationale.
  ['put_item', 'upsert'],
  ['update_item', 'update'],
  ['delete_item', 'delete'],
  // Intentionally excluded: batch_get_item, batch_write_item,
  // transact_get_items, transact_write_items. boto3's batch APIs
  // take `RequestItems={'TableName': [...]}` or `TransactItems=[{...}]`
  // structures whose table names aren't a top-level kwarg; tracking
  // those needs multi-table fan-out we haven't built.
  //
  // Known coverage gap: this plugin only matches `client.<verb>(...)`
  // call sites. The boto3 Resource API
  // (`dynamodb.Table('Orders').put_item(Item=...)`) carries the
  // table name through the `Table('...')` constructor, NOT as a
  // kwarg on `put_item`; DBI emission falls back to caller-only
  // there too. Resource-API table propagation is a follow-up.
]);

const VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // S3 — reads
  ['get_object', { service: 's3', method: 'GET' }],
  ['head_object', { service: 's3', method: 'HEAD' }],
  ['head_bucket', { service: 's3', method: 'HEAD' }],
  ['list_objects', { service: 's3', method: 'GET' }],
  ['list_objects_v2', { service: 's3', method: 'GET' }],
  ['list_object_versions', { service: 's3', method: 'GET' }],
  ['list_buckets', { service: 's3', method: 'GET' }],
  ['list_multipart_uploads', { service: 's3', method: 'GET' }],
  ['list_parts', { service: 's3', method: 'GET' }],
  ['download_file', { service: 's3', method: 'GET' }],
  ['download_fileobj', { service: 's3', method: 'GET' }],
  ['generate_presigned_url', { service: 's3', method: 'GET' }],
  ['generate_presigned_post', { service: 's3', method: 'GET' }],
  // S3 — writes
  ['put_object', { service: 's3', method: 'PUT' }],
  ['copy_object', { service: 's3', method: 'PUT' }],
  ['copy', { service: 's3', method: 'PUT' }],
  ['upload_file', { service: 's3', method: 'PUT' }],
  ['upload_fileobj', { service: 's3', method: 'PUT' }],
  ['upload_part', { service: 's3', method: 'PUT' }],
  ['upload_part_copy', { service: 's3', method: 'PUT' }],
  ['put_object_acl', { service: 's3', method: 'PUT' }],
  ['put_object_tagging', { service: 's3', method: 'PUT' }],
  ['put_bucket_acl', { service: 's3', method: 'PUT' }],
  ['put_bucket_policy', { service: 's3', method: 'PUT' }],
  ['put_bucket_cors', { service: 's3', method: 'PUT' }],
  ['put_bucket_lifecycle', { service: 's3', method: 'PUT' }],
  ['put_bucket_lifecycle_configuration', { service: 's3', method: 'PUT' }],
  ['put_bucket_tagging', { service: 's3', method: 'PUT' }],
  ['put_bucket_versioning', { service: 's3', method: 'PUT' }],
  ['put_bucket_notification', { service: 's3', method: 'PUT' }],
  ['put_bucket_notification_configuration', { service: 's3', method: 'PUT' }],
  ['put_bucket_replication', { service: 's3', method: 'PUT' }],
  ['put_bucket_encryption', { service: 's3', method: 'PUT' }],
  ['restore_object', { service: 's3', method: 'POST' }],
  ['select_object_content', { service: 's3', method: 'POST' }],
  ['create_multipart_upload', { service: 's3', method: 'POST' }],
  ['complete_multipart_upload', { service: 's3', method: 'POST' }],
  // S3 — deletes
  ['delete_object', { service: 's3', method: 'DELETE' }],
  ['delete_objects', { service: 's3', method: 'DELETE' }],
  ['delete_bucket', { service: 's3', method: 'DELETE' }],
  ['delete_bucket_policy', { service: 's3', method: 'DELETE' }],
  ['delete_object_tagging', { service: 's3', method: 'DELETE' }],
  ['abort_multipart_upload', { service: 's3', method: 'DELETE' }],

  // DynamoDB
  ['get_item', { service: 'dynamodb', method: 'GET' }],
  ['batch_get_item', { service: 'dynamodb', method: 'GET' }],
  ['query', { service: 'dynamodb', method: 'GET' }],
  ['scan', { service: 'dynamodb', method: 'GET' }],
  ['put_item', { service: 'dynamodb', method: 'PUT' }],
  ['update_item', { service: 'dynamodb', method: 'PATCH' }],
  ['delete_item', { service: 'dynamodb', method: 'DELETE' }],
  ['batch_write_item', { service: 'dynamodb', method: 'PUT' }],
  ['transact_get_items', { service: 'dynamodb', method: 'GET' }],
  ['transact_write_items', { service: 'dynamodb', method: 'PUT' }],
  ['create_table', { service: 'dynamodb', method: 'POST' }],
  ['delete_table', { service: 'dynamodb', method: 'DELETE' }],
  ['list_tables', { service: 'dynamodb', method: 'GET' }],
  ['describe_table', { service: 'dynamodb', method: 'GET' }],
  ['update_table', { service: 'dynamodb', method: 'PATCH' }],

  // SQS
  ['send_message', { service: 'sqs', method: 'JOB' }],
  ['send_message_batch', { service: 'sqs', method: 'JOB' }],
  ['receive_message', { service: 'sqs', method: 'JOB' }],
  ['delete_message', { service: 'sqs', method: 'JOB' }],
  ['delete_message_batch', { service: 'sqs', method: 'JOB' }],
  ['change_message_visibility', { service: 'sqs', method: 'JOB' }],
  ['purge_queue', { service: 'sqs', method: 'JOB' }],

  // SNS
  ['publish', { service: 'sns', method: 'JOB' }],
  ['publish_batch', { service: 'sns', method: 'JOB' }],
  ['create_topic', { service: 'sns', method: 'POST' }],
  ['delete_topic', { service: 'sns', method: 'DELETE' }],
  ['list_topics', { service: 'sns', method: 'GET' }],
  ['subscribe', { service: 'sns', method: 'POST' }],
  ['unsubscribe', { service: 'sns', method: 'DELETE' }],

  // Lambda
  ['invoke', { service: 'lambda', method: 'POST' }],
  ['invoke_async', { service: 'lambda', method: 'JOB' }],
]);

// Per-service receiver gates. Each verb only fires when its receiver
// looks like a client for THAT service. The generic word `client`
// alone is intentionally NOT allowed — otherwise things like
// `redis_client.publish('chan', msg)` would falsely emit as SNS.
// `aws` / `boto` substrings are allowed everywhere because
// `aws_clients["dynamodb"]` and `boto3.client(...)` are common.
const RECEIVER_PATTERNS: ReadonlyMap<ServiceId, RegExp> = new Map([
  ['s3', /^(?:self\.)?(?:.*(?:s3|bucket|aws|boto).*)$/i],
  ['dynamodb', /^(?:self\.)?(?:.*(?:dynamo|table|aws|boto).*)$/i],
  ['sqs', /^(?:self\.)?(?:.*(?:sqs|queue|aws|boto).*)$/i],
  ['sns', /^(?:self\.)?(?:.*(?:sns|topic|aws|boto).*)$/i],
  ['lambda', /^(?:self\.)?(?:.*(?:lambda|aws|boto).*)$/i],
]);

export function createBoto3Visitor(): PyFrameworkVisitor {
  // DDB-as-DB de-dup: emit the system once, each unique table once.
  const ddbSystemEmitted = new Set<string>();
  const ddbTableEmitted = new Set<string>();

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
      const obj = fn.childForFieldName('object');
      const attr = fn.childForFieldName('attribute');
      if (!obj || !attr) return;

      const info = VERBS.get(attr.text);
      if (!info) return;
      const receiverGate = RECEIVER_PATTERNS.get(info.service);
      if (!receiverGate || !receiverGate.test(obj.text)) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      const kwargs = args ? collectKwargs(args) : new Map<string, SyntaxNode>();
      const positional = args ? collectPositional(args) : [];

      const emit = buildEmit(info.service, attr.text, info.method, kwargs, positional);
      if (!emit) return;

      const sourceLine = node.startPosition.row + 1;
      const snippet = node.text;
      const evidence = {
        filePath: ctx.sourceFile.filePath,
        lineStart: sourceLine,
        lineEnd: node.endPosition.row + 1,
        snippet: snippet.length <= 500 ? snippet : snippet.slice(0, 499) + '…',
        confidence: emit.egressConfidence === 'exact' ? ('exact' as const) : ('heuristic' as const),
      };

      const caller: ClientSideAPICaller = {
        nodeType: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({
          sourceFileId: ctx.sourceFile.id,
          sourceLine,
          urlLiteral: emit.urlLiteral,
        }),
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine,
        httpMethod: info.method,
        urlLiteral: emit.urlLiteral,
        egressConfidence: emit.egressConfidence,
        framework: emit.framework,
        repository: ctx.sourceFile.repository,
        evidence,
        ...(emit.urlLiteral ? { isExternal: true, externalHost: emit.externalHost } : {}),
      };
      ctx.emitNode(caller);
      ctx.emitEdge({
        edgeType: 'MAKES_REQUEST',
        from: ctx.enclosingFunction.id,
        to: caller.id,
      });

      // ── DynamoDB-as-DB emission (Fix 4 of the test-apps scorecard) ──
      if (info.service === 'dynamodb') {
        const dbOp = DDB_VERB_TO_DB_OP.get(attr.text);
        // Reuse the same string-literal extractor that buildEmit's DDB
        // branch already uses — it handles prefix bytes (b/r/u),
        // triple-quoted strings, and concatenated_string nodes that a
        // naive `slice(1, -1)` would mangle.
        const tableName = stringFromKwarg(kwargs, 'TableName');
        if (dbOp && tableName) {
          emitDdbDatabaseTriple({
            ctx,
            sourceLine,
            sourceLineEnd: node.endPosition.row + 1,
            snippet: evidence.snippet,
            dbOp,
            tableName,
            ddbSystemEmitted,
            ddbTableEmitted,
          });
        }
      }
    },
  };
}

/**
 * Emit DatabaseSystem + DatabaseTable + DatabaseInteraction alongside
 * the ClientSideAPICaller for a DDB row-level call. (Fix 4)
 */
function emitDdbDatabaseTriple(args: {
  ctx: PyVisitContext;
  sourceLine: number;
  sourceLineEnd: number;
  snippet: string;
  dbOp: DatabaseOperation;
  tableName: string;
  ddbSystemEmitted: Set<string>;
  ddbTableEmitted: Set<string>;
}): void {
  const { ctx, sourceLine, sourceLineEnd, snippet, dbOp, tableName, ddbSystemEmitted, ddbTableEmitted } = args;
  if (!ctx.enclosingFunction) return;

  // Dedup keys are prefixed with the repository name (see
  // framework-awsrust-s3 for the full rationale): the DDB system id
  // is byte-identical across repos, so an unprefixed Set would
  // suppress DatabaseSystem emission for repo #2 if a visitor
  // instance is ever reused across repos.
  const repo = ctx.sourceFile.repository;
  const systemId = idFor.databaseSystem({ kind: 'dynamodb', name: 'dynamodb' });
  const systemKey = `${repo}:${systemId}`;
  if (!ddbSystemEmitted.has(systemKey)) {
    ddbSystemEmitted.add(systemKey);
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: systemId,
      kind: 'dynamodb',
      name: 'dynamodb',
      connectionSource: null,
    };
    ctx.emitNode(system);
  }

  const tableId = idFor.databaseTable({ systemId, schema: null, name: tableName });
  const tableKey = `${repo}:${tableId}`;
  if (!ddbTableEmitted.has(tableKey)) {
    ddbTableEmitted.add(tableKey);
    const table: DatabaseTable = {
      nodeType: 'DatabaseTable',
      id: tableId,
      systemId,
      name: tableName,
      schema: null,
      kind: 'table',
      declaredIn: null,
    };
    ctx.emitNode(table);
    ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
  }

  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction',
    id: idFor.databaseInteraction({
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation: dbOp,
      targetTableId: tableId,
    }),
    callSiteFunctionId: ctx.enclosingFunction.id,
    operation: dbOp,
    orm: 'boto3-dynamodb',
    rawQuery: null,
    confidence: 'direct',
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: sourceLine,
      lineEnd: sourceLineEnd,
      snippet,
      confidence: 'exact',
    },
  };
  ctx.emitNode(interaction);

  if (dbOp === 'read') {
    ctx.emitEdge({ edgeType: 'READS', from: interaction.id, to: tableId, columns: null, filters: null });
  } else {
    const kind = dbOp === 'delete' ? 'delete' : dbOp === 'update' ? 'update' : 'upsert';
    ctx.emitEdge({ edgeType: 'WRITES', from: interaction.id, to: tableId, columns: null, kind });
  }
  ctx.emitEdge({
    edgeType: 'PERFORMED_BY',
    from: interaction.id,
    to: ctx.enclosingFunction.id,
    sourceLine,
  });
}

interface EmitInfo {
  urlLiteral: string | null;
  egressConfidence: HttpEgressConfidence;
  framework: string;
  externalHost: string | null;
}

function buildEmit(
  service: ServiceId,
  verb: string,
  _method: string,
  kwargs: Map<string, SyntaxNode>,
  positional: SyntaxNode[],
): EmitInfo | null {
  switch (service) {
    case 's3': {
      // 1. Top-level Bucket=/Key= kwargs (put_object, get_object, etc.)
      // 2. Positional fallback for upload_file/download_file
      // 3. Nested in Params={"Bucket": "...", "Key": "..."} dict —
      //    used by generate_presigned_url and generate_presigned_post.
      //    (s3.copy / copy_object use a separate CopySource kwarg
      //    which is not yet handled here.)
      let bucket = stringFromKwarg(kwargs, 'Bucket') ?? s3PositionalBucket(verb, positional);
      let key = stringFromKwarg(kwargs, 'Key') ?? s3PositionalKey(verb, positional);
      if (bucket === null || key === null) {
        const paramsDict = kwargs.get('Params');
        if (paramsDict) {
          bucket ??= stringFromDictLiteral(paramsDict, 'Bucket');
          key ??= stringFromDictLiteral(paramsDict, 'Key');
        }
      }
      const { urlLiteral, egressConfidence } = buildS3Url(bucket, key);
      return {
        urlLiteral,
        egressConfidence,
        framework: 'boto3-s3',
        externalHost: bucket ? `${bucket}.s3.amazonaws.com` : null,
      };
    }
    case 'dynamodb': {
      const table = stringFromKwarg(kwargs, 'TableName');
      if (table) {
        return {
          urlLiteral: `dynamodb://${table}/`,
          egressConfidence: 'exact',
          framework: 'boto3-dynamodb',
          externalHost: 'dynamodb.amazonaws.com',
        };
      }
      return {
        urlLiteral: null,
        egressConfidence: 'dynamic',
        framework: 'boto3-dynamodb',
        externalHost: null,
      };
    }
    case 'sqs': {
      const queueUrl = stringFromKwarg(kwargs, 'QueueUrl');
      const queueName = queueUrl ? queueNameFromUrl(queueUrl) : null;
      if (queueName) {
        return {
          urlLiteral: `sqs:${queueName}`,
          egressConfidence: 'exact',
          framework: 'boto3-sqs',
          externalHost: 'sqs.amazonaws.com',
        };
      }
      return {
        urlLiteral: null,
        egressConfidence: 'dynamic',
        framework: 'boto3-sqs',
        externalHost: null,
      };
    }
    case 'sns': {
      const topicArn = stringFromKwarg(kwargs, 'TopicArn') ?? stringFromKwarg(kwargs, 'TargetArn');
      const topic = topicArn ? topicNameFromArn(topicArn) : null;
      if (topic) {
        return {
          urlLiteral: `sns:${topic}`,
          egressConfidence: 'exact',
          framework: 'boto3-sns',
          externalHost: 'sns.amazonaws.com',
        };
      }
      return {
        urlLiteral: null,
        egressConfidence: 'dynamic',
        framework: 'boto3-sns',
        externalHost: null,
      };
    }
    case 'lambda': {
      const fn = stringFromKwarg(kwargs, 'FunctionName');
      if (fn) {
        return {
          urlLiteral: `lambda:${fn}`,
          egressConfidence: 'exact',
          framework: 'boto3-lambda',
          externalHost: 'lambda.amazonaws.com',
        };
      }
      return {
        urlLiteral: null,
        egressConfidence: 'dynamic',
        framework: 'boto3-lambda',
        externalHost: null,
      };
    }
  }
}

function buildS3Url(
  bucket: string | null,
  key: string | null,
): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (bucket && key) return { urlLiteral: `s3://${bucket}/${key}`, egressConfidence: 'exact' };
  if (bucket) return { urlLiteral: `s3://${bucket}/`, egressConfidence: 'exact' };
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

function s3PositionalBucket(verb: string, positional: SyntaxNode[]): string | null {
  if (verb === 'upload_file' || verb === 'upload_fileobj') {
    return positional.length >= 2 ? extractPythonStringValue(positional[1]!) : null;
  }
  if (verb === 'download_file' || verb === 'download_fileobj') {
    return positional.length >= 1 ? extractPythonStringValue(positional[0]!) : null;
  }
  return null;
}

function s3PositionalKey(verb: string, positional: SyntaxNode[]): string | null {
  if (verb === 'upload_file' || verb === 'upload_fileobj') {
    return positional.length >= 3 ? extractPythonStringValue(positional[2]!) : null;
  }
  if (verb === 'download_file' || verb === 'download_fileobj') {
    return positional.length >= 2 ? extractPythonStringValue(positional[1]!) : null;
  }
  return null;
}

function queueNameFromUrl(url: string): string | null {
  // SQS URL: https://sqs.<region>.amazonaws.com/<account>/<queue-name>
  const tail = url.split('/').pop();
  return tail && tail.length > 0 ? tail : null;
}

function topicNameFromArn(arn: string): string | null {
  // SNS ARN: arn:aws:sns:<region>:<account>:<topic-name>
  const parts = arn.split(':');
  const tail = parts[parts.length - 1];
  return tail && tail.length > 0 ? tail : null;
}

function collectKwargs(args: SyntaxNode): Map<string, SyntaxNode> {
  const out = new Map<string, SyntaxNode>();
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c || c.type !== 'keyword_argument') continue;
    const name = c.childForFieldName('name');
    const value = c.childForFieldName('value');
    if (name && value) out.set(name.text, value);
  }
  return out;
}

function collectPositional(args: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    out.push(c);
  }
  return out;
}

function stringFromKwarg(kwargs: Map<string, SyntaxNode>, name: string): string | null {
  const v = kwargs.get(name);
  if (!v) return null;
  return extractPythonStringValue(v);
}

/**
 * Extract a string-valued entry from a Python dict literal.
 *
 *   Params={"Bucket": "my-bucket", "Key": "k", "ContentType": "..."}
 *   → stringFromDictLiteral(node, 'Bucket') → "my-bucket"
 *
 * tree-sitter-python represents this as a `dictionary` node whose
 * children include `pair` nodes (`key: value`). Returns null when the
 * key is missing or the value isn't a plain string literal.
 */
function stringFromDictLiteral(node: SyntaxNode, name: string): string | null {
  if (node.type !== 'dictionary') return null;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c || c.type !== 'pair') continue;
    const keyNode = c.childForFieldName('key');
    const valueNode = c.childForFieldName('value');
    if (!keyNode || !valueNode) continue;
    if (keyNode.type !== 'string') continue;
    const keyText = stripPythonString(keyNode.text);
    if (keyText !== name) continue;
    return extractPythonStringValue(valueNode);
  }
  return null;
}

function extractPythonStringValue(node: SyntaxNode): string | null {
  if (node.type === 'string') {
    return stripPythonString(node.text);
  }
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
  if (/^[rRbBuU]*[fF]/.test(s)) return null;  // f-strings → dynamic
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
    if (text.includes('boto3') || text.includes('aioboto3')) return true;
  }
  return false;
}
