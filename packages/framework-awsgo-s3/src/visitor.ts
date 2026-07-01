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
import type { GoFrameworkVisitor, GoVisitContext } from '@veoable/lang-go';

/**
 * aws-sdk-go-v2 visitor — covers S3, DynamoDB, SQS, SNS, Lambda.
 *
 * Call shape (consistent across all services):
 *   client.<Verb>(ctx, &<svc>.<Verb>Input{ Field: aws.String("..."), .. }, opts...)
 *
 * Each verb name routes to one service:
 *
 *   S3:        PutObject, GetObject, …    fields = Bucket / Key
 *   DynamoDB:  GetItem, PutItem, …         field  = TableName
 *   SQS:       SendMessage, …              field  = QueueUrl
 *   SNS:       Publish, …                  fields = TopicArn or TargetArn
 *   Lambda:    Invoke, InvokeAsync         field  = FunctionName
 *
 * URL conventions and externalHost stamps:
 *
 *   s3://<bucket>/<key>      <bucket>.s3.amazonaws.com
 *   dynamodb://<table>/      dynamodb.amazonaws.com
 *   sqs:<queue-name>         sqs.amazonaws.com
 *   sns:<topic-name>         sns.amazonaws.com
 *   lambda:<function>        lambda.amazonaws.com
 */

type ServiceId = 's3' | 'dynamodb' | 'sqs' | 'sns' | 'lambda';

interface VerbInfo {
  service: ServiceId;
  method: string;
}

const VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // S3
  ['GetObject', { service: 's3', method: 'GET' }],
  ['HeadObject', { service: 's3', method: 'HEAD' }],
  ['HeadBucket', { service: 's3', method: 'HEAD' }],
  ['ListObjects', { service: 's3', method: 'GET' }],
  ['ListObjectsV2', { service: 's3', method: 'GET' }],
  ['ListObjectVersions', { service: 's3', method: 'GET' }],
  ['ListBuckets', { service: 's3', method: 'GET' }],
  ['ListMultipartUploads', { service: 's3', method: 'GET' }],
  ['ListParts', { service: 's3', method: 'GET' }],
  ['GetObjectTagging', { service: 's3', method: 'GET' }],
  ['GetObjectAcl', { service: 's3', method: 'GET' }],
  ['GetBucketLocation', { service: 's3', method: 'GET' }],
  ['GetBucketPolicy', { service: 's3', method: 'GET' }],
  ['PutObject', { service: 's3', method: 'PUT' }],
  ['CopyObject', { service: 's3', method: 'PUT' }],
  ['UploadPart', { service: 's3', method: 'PUT' }],
  ['UploadPartCopy', { service: 's3', method: 'PUT' }],
  ['PutObjectAcl', { service: 's3', method: 'PUT' }],
  ['PutObjectTagging', { service: 's3', method: 'PUT' }],
  ['PutBucketPolicy', { service: 's3', method: 'PUT' }],
  ['CreateMultipartUpload', { service: 's3', method: 'POST' }],
  ['CompleteMultipartUpload', { service: 's3', method: 'POST' }],
  ['RestoreObject', { service: 's3', method: 'POST' }],
  ['SelectObjectContent', { service: 's3', method: 'POST' }],
  ['DeleteObject', { service: 's3', method: 'DELETE' }],
  ['DeleteObjects', { service: 's3', method: 'DELETE' }],
  ['DeleteBucket', { service: 's3', method: 'DELETE' }],
  ['DeleteBucketPolicy', { service: 's3', method: 'DELETE' }],
  ['DeleteObjectTagging', { service: 's3', method: 'DELETE' }],
  ['AbortMultipartUpload', { service: 's3', method: 'DELETE' }],

  // DynamoDB
  ['GetItem', { service: 'dynamodb', method: 'GET' }],
  ['BatchGetItem', { service: 'dynamodb', method: 'GET' }],
  ['Query', { service: 'dynamodb', method: 'GET' }],
  ['Scan', { service: 'dynamodb', method: 'GET' }],
  ['PutItem', { service: 'dynamodb', method: 'PUT' }],
  ['UpdateItem', { service: 'dynamodb', method: 'PATCH' }],
  ['DeleteItem', { service: 'dynamodb', method: 'DELETE' }],
  ['BatchWriteItem', { service: 'dynamodb', method: 'PUT' }],
  ['TransactGetItems', { service: 'dynamodb', method: 'GET' }],
  ['TransactWriteItems', { service: 'dynamodb', method: 'PUT' }],
  ['CreateTable', { service: 'dynamodb', method: 'POST' }],
  ['DeleteTable', { service: 'dynamodb', method: 'DELETE' }],
  ['ListTables', { service: 'dynamodb', method: 'GET' }],
  ['DescribeTable', { service: 'dynamodb', method: 'GET' }],
  ['UpdateTable', { service: 'dynamodb', method: 'PATCH' }],

  // SQS
  ['SendMessage', { service: 'sqs', method: 'JOB' }],
  ['SendMessageBatch', { service: 'sqs', method: 'JOB' }],
  ['ReceiveMessage', { service: 'sqs', method: 'JOB' }],
  ['DeleteMessage', { service: 'sqs', method: 'JOB' }],
  ['DeleteMessageBatch', { service: 'sqs', method: 'JOB' }],
  ['ChangeMessageVisibility', { service: 'sqs', method: 'JOB' }],
  ['PurgeQueue', { service: 'sqs', method: 'JOB' }],

  // SNS
  ['Publish', { service: 'sns', method: 'JOB' }],
  ['PublishBatch', { service: 'sns', method: 'JOB' }],
  ['CreateTopic', { service: 'sns', method: 'POST' }],
  ['DeleteTopic', { service: 'sns', method: 'DELETE' }],
  ['ListTopics', { service: 'sns', method: 'GET' }],
  ['Subscribe', { service: 'sns', method: 'POST' }],
  ['Unsubscribe', { service: 'sns', method: 'DELETE' }],

  // Lambda
  ['Invoke', { service: 'lambda', method: 'POST' }],
  ['InvokeAsync', { service: 'lambda', method: 'JOB' }],
]);

// Per-service receiver gates. Bare `client` is rejected — only
// receivers that mention a service-specific keyword are accepted.
// `aws`/`boto` substrings are allowed everywhere.
const RECEIVER_PATTERNS: ReadonlyMap<ServiceId, RegExp> = new Map([
  ['s3', /(?:[Ss]3|[Bb]ucket|[Aa]ws|[Bb]oto)/],
  ['dynamodb', /(?:[Dd]ynamo|[Tt]able|[Aa]ws|[Bb]oto)/],
  ['sqs', /(?:[Ss]qs|[Qq]ueue|[Aa]ws|[Bb]oto)/],
  ['sns', /(?:[Ss]ns|[Tt]opic|[Aa]ws|[Bb]oto)/],
  ['lambda', /(?:[Ll]ambda|[Aa]ws|[Bb]oto)/],
]);

const SERVICE_HOSTS: ReadonlyMap<Exclude<ServiceId, 's3'>, string> = new Map([
  ['dynamodb', 'dynamodb.amazonaws.com'],
  ['sqs', 'sqs.amazonaws.com'],
  ['sns', 'sns.amazonaws.com'],
  ['lambda', 'lambda.amazonaws.com'],
]);

const SERVICE_FRAMEWORK: ReadonlyMap<ServiceId, string> = new Map([
  ['s3', 'awsgo-s3'],
  ['dynamodb', 'awsgo-dynamodb'],
  ['sqs', 'awsgo-sqs'],
  ['sns', 'awsgo-sns'],
  ['lambda', 'awsgo-lambda'],
]);

/**
 * DynamoDB verbs that ALSO produce DatabaseInteraction nodes
 * alongside the ClientSideAPICaller (Fix 4 of the test-apps
 * scorecard, mirror of the awsrust-s3 / boto3 / aws-s3-ts emission).
 * S3/SQS/SNS/Lambda stay client-side-caller-only. Control-plane
 * verbs (CreateTable/DeleteTable/UpdateTable) intentionally don't
 * emit DBIs — they aren't row-level interactions.
 */
const DDB_VERB_TO_DB_OP: ReadonlyMap<string, DatabaseOperation> = new Map([
  ['GetItem', 'read'],
  ['Query', 'read'],
  ['Scan', 'read'],
  // PutItem REPLACES any existing item with the same primary key —
  // semantically an upsert, not a strict insert. See
  // framework-awsrust-s3 for the same rationale.
  ['PutItem', 'upsert'],
  ['UpdateItem', 'update'],
  ['DeleteItem', 'delete'],
  // Intentionally excluded: BatchGetItem, BatchWriteItem,
  // TransactGetItems, TransactWriteItems. The input structs use
  // `RequestItems` (map keyed by table) or `TransactItems` (slice
  // of per-item entries with their own `TableName`); there's no
  // single top-level `TableName` to extract. The caller still
  // emits via the parent VERBS map — the DB-graph terminal is
  // intentionally skipped until multi-table fan-out is built.
]);

export function createAwsgoS3Visitor(): GoFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  // DDB-as-DB de-dup: emit the system once, each unique table once.
  const ddbSystemEmitted = new Set<string>();
  const ddbTableEmitted = new Set<string>();
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

      const verb = VERBS.get(field.text);
      if (!verb) return;
      const gate = RECEIVER_PATTERNS.get(verb.service);
      if (!gate || !gate.test(operand.text)) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      const secondArgText = args ? nthArg(args, 1)?.text ?? '' : '';

      const emit = buildEmit(verb.service, secondArgText);
      const sourceLine = node.startPosition.row + 1;
      const snippet = node.text.slice(0, 200);
      const framework = SERVICE_FRAMEWORK.get(verb.service)!;

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
        httpMethod: verb.method,
        urlLiteral: emit.urlLiteral,
        egressConfidence: emit.egressConfidence,
        framework,
        repository: ctx.sourceFile.repository,
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: sourceLine,
          lineEnd: node.endPosition.row + 1,
          snippet,
          confidence: emit.egressConfidence === 'exact' ? ('exact' as const) : ('heuristic' as const),
        },
        ...(emit.urlLiteral ? { isExternal: true, externalHost: emit.externalHost } : {}),
      };
      ctx.emitNode(caller);
      ctx.emitEdge({
        edgeType: 'MAKES_REQUEST',
        from: ctx.enclosingFunction.id,
        to: caller.id,
      });

      // ── DynamoDB-as-DB emission (Fix 4 of the test-apps scorecard) ──
      if (verb.service === 'dynamodb') {
        const dbOp = DDB_VERB_TO_DB_OP.get(field.text);
        const tableName = extractFieldLiteral(secondArgText, 'TableName');
        if (dbOp && tableName) {
          emitDdbDatabaseTriple({
            ctx,
            sourceLine,
            sourceLineEnd: node.endPosition.row + 1,
            snippet,
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
 * the ClientSideAPICaller for a DDB row-level call. Mirrors
 * framework-mongogo's emission shape so the flow walker can
 * terminate at DDB hops as it does for Mongo. (Fix 4)
 */
function emitDdbDatabaseTriple(args: {
  ctx: GoVisitContext;
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
    orm: 'awsgo-dynamodb',
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
  externalHost: string | null;
}

function buildEmit(service: ServiceId, secondArgText: string): EmitInfo {
  switch (service) {
    case 's3': {
      const bucket = extractFieldLiteral(secondArgText, 'Bucket');
      const key = extractFieldLiteral(secondArgText, 'Key');
      return {
        ...buildS3Url(bucket, key),
        externalHost: bucket ? `${bucket}.s3.amazonaws.com` : null,
      };
    }
    case 'dynamodb': {
      const table = extractFieldLiteral(secondArgText, 'TableName');
      const host = SERVICE_HOSTS.get('dynamodb')!;
      if (table) {
        return { urlLiteral: `dynamodb://${table}/`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'sqs': {
      const queueUrl = extractFieldLiteral(secondArgText, 'QueueUrl');
      const queueName = queueUrl ? queueNameFromUrl(queueUrl) : null;
      const host = SERVICE_HOSTS.get('sqs')!;
      if (queueName) {
        return { urlLiteral: `sqs:${queueName}`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'sns': {
      const topicArn = extractFieldLiteral(secondArgText, 'TopicArn')
        ?? extractFieldLiteral(secondArgText, 'TargetArn');
      const topic = topicArn ? topicNameFromArn(topicArn) : null;
      const host = SERVICE_HOSTS.get('sns')!;
      if (topic) {
        return { urlLiteral: `sns:${topic}`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'lambda': {
      const fnName = extractFieldLiteral(secondArgText, 'FunctionName');
      const host = SERVICE_HOSTS.get('lambda')!;
      if (fnName) {
        return { urlLiteral: `lambda:${fnName}`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
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

function queueNameFromUrl(url: string): string | null {
  const tail = url.split('/').pop();
  return tail && tail.length > 0 ? tail : null;
}

function topicNameFromArn(arn: string): string | null {
  const parts = arn.split(':');
  const tail = parts[parts.length - 1];
  return tail && tail.length > 0 ? tail : null;
}

function extractFieldLiteral(text: string, field: string): string | null {
  const wrapped = new RegExp(`\\b${field}\\s*:\\s*aws\\.String\\(\\s*"([^"]*)"\\s*,?\\s*\\)`);
  const wm = wrapped.exec(text);
  if (wm) return wm[1] ?? null;
  const wrapped2 = new RegExp(`\\b${field}\\s*:\\s*aws\\.(?:ToString|StringValue)\\(\\s*"([^"]*)"\\s*,?\\s*\\)`);
  const wm2 = wrapped2.exec(text);
  if (wm2) return wm2[1] ?? null;
  const direct = new RegExp(`\\b${field}\\s*:\\s*"([^"]*)"`);
  const dm = direct.exec(text);
  if (dm) return dm[1] ?? null;
  return null;
}

function nthArg(args: SyntaxNode, index: number): SyntaxNode | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === index) return c;
    seen++;
  }
  return null;
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  const NEEDLES = [
    'aws-sdk-go-v2/service/s3',
    'aws-sdk-go-v2/service/dynamodb',
    'aws-sdk-go-v2/service/sqs',
    'aws-sdk-go-v2/service/sns',
    'aws-sdk-go-v2/service/lambda',
    'aws-sdk-go/service/s3',
    'aws-sdk-go/service/dynamodb',
    'aws-sdk-go/service/sqs',
    'aws-sdk-go/service/sns',
    'aws-sdk-go/service/lambda',
  ];
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_declaration') continue;
    const t = c.text;
    if (NEEDLES.some((n) => t.includes(n))) return true;
  }
  return false;
}
