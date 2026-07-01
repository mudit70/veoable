import { Node, type ObjectLiteralExpression, type PropertyAssignment } from 'ts-morph';
import {
  idFor,
  type ClientSideAPICaller,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseSystem,
  type DatabaseTable,
  type HttpEgressConfidence,
} from '@veoable/schema';
import {
  buildEvidence,
  readStringLiteral,
  type TsFrameworkVisitor,
  type TsVisitContext,
} from '@veoable/lang-ts';

/**
 * AWS SDK v3 visitor — covers S3, DynamoDB, SQS, SNS, Lambda.
 *
 * Detects v3 command instantiations:
 *
 *   new GetObjectCommand({ Bucket: 'b', Key: 'k' })
 *   new GetItemCommand({ TableName: 'users', Key: {...} })
 *   new SendMessageCommand({ QueueUrl: '...', MessageBody: '...' })
 *   new PublishCommand({ TopicArn: '...', Message: '...' })
 *   new InvokeCommand({ FunctionName: '...', Payload: ... })
 *
 * Each command name routes to exactly one service via the unified
 * registry. The visitor extracts the service-specific identifier from
 * the command's options object:
 *   - S3:        Bucket / Key
 *   - DynamoDB:  TableName
 *   - SQS:       QueueUrl (tail = queue name)
 *   - SNS:       TopicArn or TargetArn (tail = topic name)
 *   - Lambda:    FunctionName
 *
 * URL conventions and externalHost stamps:
 *
 *   s3://<bucket>/<key>      <bucket>.s3.amazonaws.com   framework=aws-s3-ts
 *   dynamodb://<table>/      dynamodb.amazonaws.com      framework=aws-dynamodb-ts
 *   sqs:<queue-name>         sqs.amazonaws.com           framework=aws-sqs-ts
 *   sns:<topic-name>         sns.amazonaws.com           framework=aws-sns-ts
 *   lambda:<fn>              lambda.amazonaws.com        framework=aws-lambda-ts
 *
 * Per-file gate: any import from one of the @aws-sdk/client-* packages.
 * Without the gate, a third-party class named e.g. `PutObjectCommand`
 * in an unrelated package would falsely match.
 */

type ServiceId = 's3' | 'dynamodb' | 'sqs' | 'sns' | 'lambda';

interface CommandInfo {
  service: ServiceId;
  method: string;
}

const COMMANDS: ReadonlyMap<string, CommandInfo> = new Map([
  // S3
  ['GetObjectCommand', { service: 's3', method: 'GET' }],
  ['HeadObjectCommand', { service: 's3', method: 'HEAD' }],
  ['HeadBucketCommand', { service: 's3', method: 'HEAD' }],
  ['ListObjectsCommand', { service: 's3', method: 'GET' }],
  ['ListObjectsV2Command', { service: 's3', method: 'GET' }],
  ['ListObjectVersionsCommand', { service: 's3', method: 'GET' }],
  ['ListBucketsCommand', { service: 's3', method: 'GET' }],
  ['ListMultipartUploadsCommand', { service: 's3', method: 'GET' }],
  ['ListPartsCommand', { service: 's3', method: 'GET' }],
  ['GetObjectTaggingCommand', { service: 's3', method: 'GET' }],
  ['GetObjectAclCommand', { service: 's3', method: 'GET' }],
  ['GetBucketLocationCommand', { service: 's3', method: 'GET' }],
  ['GetBucketPolicyCommand', { service: 's3', method: 'GET' }],
  ['PutObjectCommand', { service: 's3', method: 'PUT' }],
  ['CopyObjectCommand', { service: 's3', method: 'PUT' }],
  ['UploadPartCommand', { service: 's3', method: 'PUT' }],
  ['UploadPartCopyCommand', { service: 's3', method: 'PUT' }],
  ['PutObjectAclCommand', { service: 's3', method: 'PUT' }],
  ['PutObjectTaggingCommand', { service: 's3', method: 'PUT' }],
  ['PutBucketPolicyCommand', { service: 's3', method: 'PUT' }],
  ['CreateMultipartUploadCommand', { service: 's3', method: 'POST' }],
  ['CompleteMultipartUploadCommand', { service: 's3', method: 'POST' }],
  ['RestoreObjectCommand', { service: 's3', method: 'POST' }],
  ['SelectObjectContentCommand', { service: 's3', method: 'POST' }],
  ['DeleteObjectCommand', { service: 's3', method: 'DELETE' }],
  ['DeleteObjectsCommand', { service: 's3', method: 'DELETE' }],
  ['DeleteBucketCommand', { service: 's3', method: 'DELETE' }],
  ['DeleteBucketPolicyCommand', { service: 's3', method: 'DELETE' }],
  ['DeleteObjectTaggingCommand', { service: 's3', method: 'DELETE' }],
  ['AbortMultipartUploadCommand', { service: 's3', method: 'DELETE' }],

  // DynamoDB
  ['GetItemCommand', { service: 'dynamodb', method: 'GET' }],
  ['BatchGetItemCommand', { service: 'dynamodb', method: 'GET' }],
  ['QueryCommand', { service: 'dynamodb', method: 'GET' }],
  ['ScanCommand', { service: 'dynamodb', method: 'GET' }],
  ['PutItemCommand', { service: 'dynamodb', method: 'PUT' }],
  ['UpdateItemCommand', { service: 'dynamodb', method: 'PATCH' }],
  ['DeleteItemCommand', { service: 'dynamodb', method: 'DELETE' }],
  ['BatchWriteItemCommand', { service: 'dynamodb', method: 'PUT' }],
  ['TransactGetItemsCommand', { service: 'dynamodb', method: 'GET' }],
  ['TransactWriteItemsCommand', { service: 'dynamodb', method: 'PUT' }],
  ['CreateTableCommand', { service: 'dynamodb', method: 'POST' }],
  ['DeleteTableCommand', { service: 'dynamodb', method: 'DELETE' }],
  ['ListTablesCommand', { service: 'dynamodb', method: 'GET' }],
  ['DescribeTableCommand', { service: 'dynamodb', method: 'GET' }],
  ['UpdateTableCommand', { service: 'dynamodb', method: 'PATCH' }],

  // SQS
  ['SendMessageCommand', { service: 'sqs', method: 'JOB' }],
  ['SendMessageBatchCommand', { service: 'sqs', method: 'JOB' }],
  ['ReceiveMessageCommand', { service: 'sqs', method: 'JOB' }],
  ['DeleteMessageCommand', { service: 'sqs', method: 'JOB' }],
  ['DeleteMessageBatchCommand', { service: 'sqs', method: 'JOB' }],
  ['ChangeMessageVisibilityCommand', { service: 'sqs', method: 'JOB' }],
  ['PurgeQueueCommand', { service: 'sqs', method: 'JOB' }],

  // SNS
  ['PublishCommand', { service: 'sns', method: 'JOB' }],
  ['PublishBatchCommand', { service: 'sns', method: 'JOB' }],
  ['CreateTopicCommand', { service: 'sns', method: 'POST' }],
  ['DeleteTopicCommand', { service: 'sns', method: 'DELETE' }],
  ['ListTopicsCommand', { service: 'sns', method: 'GET' }],
  ['SubscribeCommand', { service: 'sns', method: 'POST' }],
  ['UnsubscribeCommand', { service: 'sns', method: 'DELETE' }],

  // Lambda
  ['InvokeCommand', { service: 'lambda', method: 'POST' }],
  ['InvokeAsyncCommand', { service: 'lambda', method: 'JOB' }],
]);

const SERVICE_FRAMEWORK: ReadonlyMap<ServiceId, string> = new Map([
  ['s3', 'aws-s3-ts'],
  ['dynamodb', 'aws-dynamodb-ts'],
  ['sqs', 'aws-sqs-ts'],
  ['sns', 'aws-sns-ts'],
  ['lambda', 'aws-lambda-ts'],
]);

const SERVICE_HOSTS: ReadonlyMap<Exclude<ServiceId, 's3'>, string> = new Map([
  ['dynamodb', 'dynamodb.amazonaws.com'],
  ['sqs', 'sqs.amazonaws.com'],
  ['sns', 'sns.amazonaws.com'],
  ['lambda', 'lambda.amazonaws.com'],
]);

const AWS_SDK_IMPORT_PREFIXES = [
  '@aws-sdk/client-s3',
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/client-sqs',
  '@aws-sdk/client-sns',
  '@aws-sdk/client-lambda',
];

// DDB-as-DB: row-level command classes map to a logical DB operation.
// Table-level commands (CreateTable/DeleteTable/ListTables/...) stay
// API-only — they don't represent row reads or writes.
const DDB_COMMAND_TO_DB_OP: ReadonlyMap<string, DatabaseOperation> = new Map([
  ['GetItemCommand', 'read'],
  ['QueryCommand', 'read'],
  ['ScanCommand', 'read'],
  // PutItemCommand REPLACES any existing item with the same primary
  // key — semantically an upsert, not a strict insert. See
  // framework-awsrust-s3 for the same rationale.
  ['PutItemCommand', 'upsert'],
  ['UpdateItemCommand', 'update'],
  ['DeleteItemCommand', 'delete'],
  // Intentionally excluded: BatchGetItemCommand, BatchWriteItemCommand,
  // TransactGetItemsCommand, TransactWriteItemsCommand. Their input
  // objects use `RequestItems` (record keyed by table) or
  // `TransactItems` (array with per-item `TableName`) — there's no
  // top-level `TableName` to extract. The caller still emits via
  // the parent COMMANDS map.
]);

export function createAwsS3TsVisitor(): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  // DDB-as-DB dedup: emit the system once, each unique table once.
  const ddbSystemEmitted = new Set<string>();
  const ddbTableEmitted = new Set<string>();

  const fileImports = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return AWS_SDK_IMPORT_PREFIXES.some((p) => spec === p || spec.startsWith(`${p}/`));
    });
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isNewExpression(node)) return;
      if (!fileImports(node, ctx.sourceFile.filePath)) return;
      if (!ctx.enclosingFunction) return;

      const callee = node.getExpression();
      let calleeName: string | null = null;
      if (Node.isIdentifier(callee)) calleeName = callee.getText();
      else if (Node.isPropertyAccessExpression(callee)) calleeName = callee.getNameNode().getText();
      if (!calleeName) return;

      const info = COMMANDS.get(calleeName);
      if (!info) return;

      const opts = firstObjectLiteralArg(node.getArguments());
      const emit = buildEmit(info.service, opts);

      const evidence = buildEvidence(node, ctx.sourceFile.filePath);
      const framework = SERVICE_FRAMEWORK.get(info.service)!;

      const caller: ClientSideAPICaller = {
        nodeType: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({
          sourceFileId: ctx.sourceFile.id,
          sourceLine: evidence.lineStart,
          urlLiteral: emit.urlLiteral,
        }),
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine: evidence.lineStart,
        httpMethod: info.method,
        urlLiteral: emit.urlLiteral,
        egressConfidence: emit.egressConfidence,
        framework,
        repository: ctx.sourceFile.repository,
        evidence: {
          ...evidence,
          confidence: emit.egressConfidence === 'exact' ? 'exact' : 'heuristic',
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
      if (info.service === 'dynamodb') {
        const dbOp = DDB_COMMAND_TO_DB_OP.get(calleeName);
        const tableName = opts ? readPropertyStringLiteral(opts, 'TableName') : null;
        if (dbOp && tableName) {
          emitDdbDatabaseTriple({
            ctx,
            sourceLine: evidence.lineStart,
            sourceLineEnd: evidence.lineEnd,
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
 * the ClientSideAPICaller for a DDB row-level command. (Fix 4)
 */
function emitDdbDatabaseTriple(args: {
  ctx: TsVisitContext;
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
    orm: 'aws-dynamodb-ts',
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

function buildEmit(service: ServiceId, opts: ObjectLiteralExpression | null): EmitInfo {
  switch (service) {
    case 's3': {
      const bucket = opts ? readPropertyStringLiteral(opts, 'Bucket') : null;
      const key = opts ? readPropertyStringLiteral(opts, 'Key') : null;
      return {
        ...buildS3Url(bucket, key),
        externalHost: bucket ? `${bucket}.s3.amazonaws.com` : null,
      };
    }
    case 'dynamodb': {
      const table = opts ? readPropertyStringLiteral(opts, 'TableName') : null;
      const host = SERVICE_HOSTS.get('dynamodb')!;
      if (table) {
        return { urlLiteral: `dynamodb://${table}/`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'sqs': {
      const queueUrl = opts ? readPropertyStringLiteral(opts, 'QueueUrl') : null;
      const queueName = queueUrl ? queueNameFromUrl(queueUrl) : null;
      const host = SERVICE_HOSTS.get('sqs')!;
      if (queueName) {
        return { urlLiteral: `sqs:${queueName}`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'sns': {
      const topicArn = opts
        ? (readPropertyStringLiteral(opts, 'TopicArn') ?? readPropertyStringLiteral(opts, 'TargetArn'))
        : null;
      const topic = topicArn ? topicNameFromArn(topicArn) : null;
      const host = SERVICE_HOSTS.get('sns')!;
      if (topic) {
        return { urlLiteral: `sns:${topic}`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'lambda': {
      const fn = opts ? readPropertyStringLiteral(opts, 'FunctionName') : null;
      const host = SERVICE_HOSTS.get('lambda')!;
      if (fn) {
        return { urlLiteral: `lambda:${fn}`, egressConfidence: 'exact', externalHost: host };
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

function firstObjectLiteralArg(args: readonly Node[]): ObjectLiteralExpression | null {
  const first = args[0];
  if (!first) return null;
  if (Node.isObjectLiteralExpression(first)) return first;
  return null;
}

function readPropertyStringLiteral(obj: ObjectLiteralExpression, name: string): string | null {
  const prop = obj.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init) return null;
  return readStringLiteral(init);
}
