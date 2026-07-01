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
import { hasCrateImport, type RustFrameworkVisitor } from '@veoable/lang-rust';

/**
 * aws-sdk-s3 (Rust) visitor.
 *
 * The aws-sdk-s3 client uses a fluent builder for every operation:
 *
 *   client.put_object()
 *       .bucket("my-bucket")
 *       .key("path/to/file")
 *       .body(body.into())
 *       .send()
 *       .await?
 *
 * Detection strategy:
 *   1. Match `<recv>.<verb>()` where `<verb>` is one of the known
 *      operation names (verb_map below). That `()` returns a builder.
 *   2. Walk UP from the verb call to find a `.send()` call. Between
 *      them, look for `.bucket("...")` and `.key("...")` chained
 *      calls and extract their string-literal args.
 *   3. Emit one ClientSideAPICaller per `<verb>().send()` pair,
 *      keyed by the builder's start (the verb-call line).
 *
 * Easier implementation: text-based regex on the surrounding source
 * (same robustness pattern framework-awsgo-s3 uses). We anchor the
 * regex on a known verb (e.g. `\.put_object\(\)`) and look forward
 * within the enclosing chain for `.bucket("...")` and `.key("...")`.
 *
 * Per-file gate: file must `use aws_sdk_s3` (snake_case crate name).
 */

type ServiceId = 's3' | 'dynamodb' | 'sqs' | 'sns' | 'lambda';

interface VerbInfo {
  service: ServiceId;
  method: string;
}

const VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // S3
  ['get_object', { service: 's3', method: 'GET' }],
  ['head_object', { service: 's3', method: 'HEAD' }],
  ['head_bucket', { service: 's3', method: 'HEAD' }],
  ['list_objects', { service: 's3', method: 'GET' }],
  ['list_objects_v2', { service: 's3', method: 'GET' }],
  ['list_object_versions', { service: 's3', method: 'GET' }],
  ['list_buckets', { service: 's3', method: 'GET' }],
  ['list_multipart_uploads', { service: 's3', method: 'GET' }],
  ['list_parts', { service: 's3', method: 'GET' }],
  ['get_object_tagging', { service: 's3', method: 'GET' }],
  ['get_object_acl', { service: 's3', method: 'GET' }],
  ['get_bucket_location', { service: 's3', method: 'GET' }],
  ['get_bucket_policy', { service: 's3', method: 'GET' }],
  ['put_object', { service: 's3', method: 'PUT' }],
  ['copy_object', { service: 's3', method: 'PUT' }],
  ['upload_part', { service: 's3', method: 'PUT' }],
  ['upload_part_copy', { service: 's3', method: 'PUT' }],
  ['put_object_acl', { service: 's3', method: 'PUT' }],
  ['put_object_tagging', { service: 's3', method: 'PUT' }],
  ['put_bucket_policy', { service: 's3', method: 'PUT' }],
  ['create_multipart_upload', { service: 's3', method: 'POST' }],
  ['complete_multipart_upload', { service: 's3', method: 'POST' }],
  ['restore_object', { service: 's3', method: 'POST' }],
  ['select_object_content', { service: 's3', method: 'POST' }],
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

const SERVICE_FRAMEWORK: ReadonlyMap<ServiceId, string> = new Map([
  ['s3', 'awsrust-s3'],
  ['dynamodb', 'awsrust-dynamodb'],
  ['sqs', 'awsrust-sqs'],
  ['sns', 'awsrust-sns'],
  ['lambda', 'awsrust-lambda'],
]);

const SERVICE_HOSTS: ReadonlyMap<Exclude<ServiceId, 's3'>, string> = new Map([
  ['dynamodb', 'dynamodb.amazonaws.com'],
  ['sqs', 'sqs.amazonaws.com'],
  ['sns', 'sns.amazonaws.com'],
  ['lambda', 'lambda.amazonaws.com'],
]);

/**
 * DynamoDB verbs that ALSO produce DatabaseInteraction nodes
 * alongside the ClientSideAPICaller (Fix 4 of the test-apps
 * scorecard). DDB is the only AWS service in this plugin that's
 * semantically a database — S3 / SQS / SNS / Lambda stay
 * client-side-caller-only. The map gates which DDB verbs get
 * DBI emission and what canonical operation each maps to.
 *
 * `create_table` / `delete_table` / `update_table` are control-plane
 * verbs (schema admin) and intentionally don't emit DBIs — they
 * don't represent a row-level interaction that the flow walker
 * should terminate on as a "DB hop".
 */
const DDB_VERB_TO_DB_OP: ReadonlyMap<string, DatabaseOperation> = new Map([
  ['get_item', 'read'],
  ['query', 'read'],
  ['scan', 'read'],
  // PutItem REPLACES any existing item with the same primary key —
  // semantically an upsert, not a strict insert. The schema's
  // DatabaseOperation enum and the WRITES edge's `kind` enum both
  // carry `'upsert'`; using it lets downstream analysis distinguish
  // upserts from inserts that would fail on key conflict.
  ['put_item', 'upsert'],
  ['update_item', 'update'],
  ['delete_item', 'delete'],
  // Intentionally excluded: batch_get_item, batch_write_item,
  // transact_get_items, transact_write_items. These verbs don't
  // take a top-level `table_name` argument — the table(s) live
  // inside `request_items` / `transact_items` collections. Emitting
  // a DBI would require multi-table fan-out logic we haven't
  // built yet. The caller still emits via the parent VERBS map;
  // only the DB-graph terminal is skipped, so flow walks degrade
  // to "handler-only" instead of stopping at a wrong-table DBI.
]);

export function createAwsrustS3Visitor(
  structMap?: { byFieldName: ReadonlyMap<string, string> },
): RustFrameworkVisitor {
  const fieldLookup = structMap?.byFieldName;
  // Local wrapper: try the literal extractor first; if it returns
  // null and we have a struct-field map, try resolving identifier
  // args like `&state.X` / `state.X` / `&self.X`. (#523 item 1)
  const extract = (text: string, name: string): string | null => {
    const lit = extractFluentArg(text, name);
    if (lit !== null) return lit;
    if (!fieldLookup || fieldLookup.size === 0) return null;
    return extractFluentArgViaStructField(text, name, fieldLookup);
  };
  return _createAwsrustS3Visitor(extract);
}

function _createAwsrustS3Visitor(
  extractArg: (text: string, name: string) => string | null,
): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emitted = new Set<string>();

  // Per-repository DDB system + per-(repository, table-name) table
  // node de-dup. The first DDB caller seen in the repo triggers
  // emission of the DatabaseSystem node; subsequent table lookups
  // reuse the same systemId.
  const ddbSystemEmitted = new Set<string>();
  const ddbTableEmitted = new Set<string>();

  const AWS_CRATES = ['aws_sdk_s3', 'aws-sdk-s3', 'aws_sdk_dynamodb', 'aws-sdk-dynamodb',
    'aws_sdk_sqs', 'aws-sdk-sqs', 'aws_sdk_sns', 'aws-sdk-sns', 'aws_sdk_lambda', 'aws-sdk-lambda'];
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = AWS_CRATES.some((c) => hasCrateImport(root, c));
    importsByFile.set(filePath, value);
    return value;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'field_expression') return;
      const field = fn.childForFieldName('field');
      const operand = fn.childForFieldName('value');
      if (!field || !operand) return;

      const verb = VERBS.get(field.text);
      if (!verb) return;
      // The verb call must be empty-arg (the SDK's builder convention).
      const args = node.childForFieldName('arguments');
      if (args && hasAnyArg(args)) return;
      if (!ctx.enclosingFunction) return;

      // Dedupe — a verb that's a substring of another builder chain
      // could be visited multiple times via parent-walks.
      const key = `${ctx.sourceFile.filePath}:${node.startPosition.row + 1}`;
      if (emitted.has(key)) return;
      emitted.add(key);

      // Walk up to the enclosing statement to capture the full builder
      // chain text, then pull per-service identifiers out via regex.
      const chainText = enclosingStatementText(node);
      const emit = buildEmit(verb.service, chainText, extractArg);

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
      // For DDB row-level verbs with a resolvable table name, also
      // emit the DatabaseSystem + DatabaseTable + DatabaseInteraction
      // alongside the ClientSideAPICaller. The flow walker terminates
      // at DBIs as "DB hops", so a stitched fetch→handler→DDB chain
      // can complete instead of dead-ending at the outbound caller.
      // S3 / SQS / SNS / Lambda stay client-side-caller-only — they
      // aren't databases. Only DDB gets the dual emission.
      if (verb.service === 'dynamodb') {
        const dbOp = DDB_VERB_TO_DB_OP.get(field.text);
        const tableName = extractArg(chainText, 'table_name');
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
 * Emit the DatabaseSystem / DatabaseTable / DatabaseInteraction
 * triple for a single DDB row-level call, along with the canonical
 * READS / WRITES + TABLE_IN + PERFORMED_BY edges. Mirrors what
 * framework-mongogo emits for Mongo collection ops.
 */
function emitDdbDatabaseTriple(args: {
  ctx: import('@veoable/lang-rust').RustVisitContext;
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
  // Dedup keys are prefixed with the repository name. The visitor
  // factory is invoked fresh per-repo today, so the Sets only ever
  // hold one repo's worth of ids — but the system id
  // `databaseSystem({kind:'dynamodb', name:'dynamodb'})` is byte-
  // identical across repos. If a future change ever reuses a visitor
  // instance across repos, an unprefixed Set would suppress the
  // DatabaseSystem emission for repo #2 and leave its DBIs with a
  // dangling `systemId`. The prefix keeps each (repo, system) pair
  // distinct.
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
      // DDB items live in "tables" in the SDK vocabulary; the
      // DatabaseTableKind enum's `'table'` matches this directly.
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
    orm: 'awsrust-dynamodb',
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

function buildEmit(
  service: ServiceId,
  chainText: string,
  extract: (text: string, name: string) => string | null,
): EmitInfo {
  switch (service) {
    case 's3': {
      const bucket = extract(chainText, 'bucket');
      const k = extract(chainText, 'key');
      return {
        ...buildS3Url(bucket, k),
        externalHost: bucket ? `${bucket}.s3.amazonaws.com` : null,
      };
    }
    case 'dynamodb': {
      const table = extract(chainText, 'table_name');
      const host = SERVICE_HOSTS.get('dynamodb')!;
      if (table) {
        return { urlLiteral: `dynamodb://${table}/`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'sqs': {
      const queueUrl = extract(chainText, 'queue_url');
      const queueName = queueUrl ? queueNameFromUrl(queueUrl) : null;
      const host = SERVICE_HOSTS.get('sqs')!;
      if (queueName) {
        return { urlLiteral: `sqs:${queueName}`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'sns': {
      const topicArn = extract(chainText, 'topic_arn')
        ?? extract(chainText, 'target_arn');
      const topic = topicArn ? topicNameFromArn(topicArn) : null;
      const host = SERVICE_HOSTS.get('sns')!;
      if (topic) {
        return { urlLiteral: `sns:${topic}`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
    case 'lambda': {
      const fnName = extract(chainText, 'function_name');
      const host = SERVICE_HOSTS.get('lambda')!;
      if (fnName) {
        return { urlLiteral: `lambda:${fnName}`, egressConfidence: 'exact', externalHost: host };
      }
      return { urlLiteral: null, egressConfidence: 'dynamic', externalHost: null };
    }
  }
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

function buildS3Url(
  bucket: string | null,
  key: string | null,
): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (bucket && key) return { urlLiteral: `s3://${bucket}/${key}`, egressConfidence: 'exact' };
  if (bucket) return { urlLiteral: `s3://${bucket}/`, egressConfidence: 'exact' };
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

function hasAnyArg(args: SyntaxNode): boolean {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    return true;
  }
  return false;
}

/**
 * Walk UP from the verb call only through chain-continuation parents
 * — field-access, chained call, `.await`, `?` — so we capture exactly
 * THIS builder chain and never sibling calls in the same function.
 *
 * Stops at the first non-chain parent (statement, block, function
 * body), giving us strictly `<recv>.<verb>().bucket(...).key(...).
 * send().await?` as a single contiguous expression.
 */
function enclosingStatementText(node: SyntaxNode): string {
  let top: SyntaxNode = node;
  while (top.parent) {
    const p = top.parent;
    // top is the receiver of a further field access (`top.<field>`)
    if (p.type === 'field_expression' && p.childForFieldName('value')?.id === top.id) {
      top = p;
      continue;
    }
    // top is the function being called (`top(args)`)
    if (p.type === 'call_expression' && p.childForFieldName('function')?.id === top.id) {
      top = p;
      continue;
    }
    // Trailing `.await` and `?` keep us inside the chain.
    if (p.type === 'await_expression' || p.type === 'try_expression') {
      top = p;
      continue;
    }
    break;
  }
  return top.text;
}

/**
 * Find `.<name>("literal")` (or the `set_<name>(Some("literal"))`
 * builder-with-Options form) in the chain text and return the
 * literal value. Returns null when the arg is an identifier or other
 * non-string expression.
 */
/**
 * #523 item 1 — secondary resolution path for identifier args like
 * `.table_name(&state.orders_table)`. The visitor's primary literal
 * extractor (`extractFluentArg`) only matches string literals at the
 * call site. This pass looks at the same call's argument expression,
 * extracts the trailing struct-field name (`orders_table` from
 * `&state.orders_table`, `state.orders_table`, `&self.orders_table`,
 * etc.), and looks it up in the project-load-time struct-field map.
 *
 * Returns the field's default literal when found, otherwise null
 * (caller falls back to dynamic).
 */
function extractFluentArgViaStructField(
  text: string,
  name: string,
  fieldLookup: ReadonlyMap<string, string>,
): string | null {
  // `.<name>(<expr>)` — capture the argument expression up to the
  // matching close paren. Simple parser: count paren depth so nested
  // calls in the expr don't terminate it early.
  const headRe = new RegExp(`\\.${name}\\s*\\(\\s*`);
  const headMatch = headRe.exec(text);
  if (!headMatch) return null;
  const start = headMatch.index + headMatch[0].length;
  let depth = 1;
  let end = start;
  for (; end < text.length; end++) {
    const ch = text[end];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  let argExpr = text.slice(start, end).trim();
  // Strip trailing method-call chains so `state.X.clone()`,
  // `state.X.as_str()`, `state.X.to_owned()` collapse to `state.X`.
  // Repeatedly peel off `.<ident>(...)` from the right.
  while (true) {
    const stripped = argExpr.replace(/\.[A-Za-z_][\w]*\s*\([^)]*\)\s*$/, '');
    if (stripped === argExpr) break;
    argExpr = stripped.trim();
  }
  // Match the trailing identifier in shapes like `&state.X`,
  // `state.X`, `&self.X`, `self.X`. Allow chained access
  // (`&state.config.X`) by taking the last `.<ident>` segment.
  const fieldRe = /(?:&\s*)?(?:[A-Za-z_][\w]*\s*\.)+([A-Za-z_][\w]*)\s*$/;
  const fm = fieldRe.exec(argExpr);
  if (fm) {
    const fieldName = fm[1]!;
    const v = fieldLookup.get(fieldName);
    if (v !== undefined) return v;
  }
  // Bare identifier: `&queue_url`, `queue_url`. Used when the call
  // arg references a `let`-bound variable rather than a struct field.
  const bareRe = /^(?:&\s*)?([a-z_][\w]*)\s*$/;
  const bm = bareRe.exec(argExpr);
  if (bm) {
    const v = fieldLookup.get(bm[1]!);
    if (v !== undefined) return v;
  }
  return null;
}

function extractFluentArg(text: string, name: string): string | null {
  // Direct string literal — `.bucket("name")` or `.key("path/to/file")`.
  const direct = new RegExp(`\\.${name}\\s*\\(\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`);
  const dm = direct.exec(text);
  if (dm) return dm[1].replace(/\\"/g, '"');
  // .into() / .to_string() wrapper — `.bucket("name".to_string())`.
  const wrapped = new RegExp(`\\.${name}\\s*\\(\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*\\.(?:into|to_string|to_owned)\\s*\\(\\s*\\)`);
  const wm = wrapped.exec(text);
  if (wm) return wm[1].replace(/\\"/g, '"');
  // Alternative `set_<name>(Some("literal"))` setter form.
  const setForm = new RegExp(`\\.set_${name}\\s*\\(\\s*Some\\s*\\(\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`);
  const sm = setForm.exec(text);
  if (sm) return sm[1].replace(/\\"/g, '"');
  // Alternative `set_<name>(Some("literal".to_string()))`.
  const setWrapped = new RegExp(`\\.set_${name}\\s*\\(\\s*Some\\s*\\(\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*\\.(?:into|to_string|to_owned)\\s*\\(\\s*\\)`);
  const swm = setWrapped.exec(text);
  if (swm) return swm[1].replace(/\\"/g, '"');
  return null;
}
