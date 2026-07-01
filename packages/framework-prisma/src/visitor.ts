import { Node, type CallExpression, type TaggedTemplateExpression } from 'ts-morph';
import {
  idFor,
  type DatabaseOperation,
  type DatabaseInteractionConfidence,
} from '@veoable/schema';
import { recordConfidenceDecision } from '@veoable/observability';
import { type TsFrameworkVisitor, buildEvidence } from '@veoable/lang-ts';
import { modelNameFromAccessor } from './model-name.js';
import { classifyPrismaReceiver, type ResolverTrace } from './resolve-receiver.js';

/**
 * Prisma Client call-site visitor (#47 PR 2).
 *
 * Walks the TypeScript AST via the `TsFrameworkVisitor` hook and
 * detects Prisma Client CRUD calls of the form:
 *
 *   prisma.<model>.<crudMethod>(...)        — the canonical shape
 *   db.<model>.<crudMethod>(...)            — common alias
 *   client.<model>.<crudMethod>(...)        — common alias
 *   this.prisma.<model>.<crudMethod>(...)   — class-bound prisma member
 *   this.db.<model>.<crudMethod>(...)
 *   prisma.$queryRaw`...`                   — raw template literal
 *   prisma.$executeRaw(...)                 — raw execution
 *
 * For each detected call site it emits:
 *   - A `DatabaseInteraction` node
 *   - A `READS` or `WRITES` edge from the interaction to the
 *     `DatabaseTable` the schema parser emitted in PR 1 (by
 *     content-addressed id, so the edge lands on the correct table
 *     without the visitor needing to hold a reference to the schema
 *     batch)
 *   - A `PERFORMED_BY` edge from the interaction to the enclosing
 *     `FunctionDefinition` (if any — module-top-level calls are
 *     silently skipped because there's no caller to attribute to)
 *
 * Confidence taxonomy:
 *   - `direct`   — receiver expression is AST-proved to be bound to
 *                  `new PrismaClient(...)` (variable name irrelevant)
 *   - `dynamic`  — raw ($queryRaw / $executeRaw) where we cannot
 *                  determine which table is being touched
 *
 * Receiver detection (#6) uses AST-based classification via
 * `classifyPrismaReceiver`. The receiver expression's declaration is
 * traced back to its initializer, and the call is accepted if the
 * initializer is `new PrismaClient(...)`. The variable name does NOT
 * factor into acceptance — `database`, `orm`, `prismaClient`, etc.
 * are all recognized when bound to a PrismaClient construction.
 */

/** CRUD method → operation mapping for Prisma Client. */
const CRUD_OPERATIONS: ReadonlyMap<string, DatabaseOperation> = new Map([
  // Reads
  ['findMany', 'read'],
  ['findUnique', 'read'],
  ['findUniqueOrThrow', 'read'],
  ['findFirst', 'read'],
  ['findFirstOrThrow', 'read'],
  ['count', 'read'],
  ['aggregate', 'read'],
  ['groupBy', 'read'],
  // Writes (insert)
  ['create', 'write'],
  ['createMany', 'write'],
  ['createManyAndReturn', 'write'],
  // Updates
  ['update', 'update'],
  ['updateMany', 'update'],
  ['updateManyAndReturn', 'update'],
  // Deletes
  ['delete', 'delete'],
  ['deleteMany', 'delete'],
  // Upserts
  ['upsert', 'upsert'],
]);

/** Raw-access methods on the Prisma client itself (not on a model). */
const RAW_METHODS: ReadonlySet<string> = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

/**
 * Canonical receiver names used to decide whether an AST-resolved
 * call site is "noteworthy" enough to log a telemetry event. Calls
 * via `prisma`, `db`, `client`, `this.prisma`, or `this.db` are the
 * conventional shapes — anything else is a non-conventional binding
 * (e.g. `database`, `orm`, `prismaClient`) that AST resolution
 * caught and that the prior name-regex heuristic would have missed.
 */
const CANONICAL_RECEIVER_NAMES: ReadonlySet<string> = new Set([
  'prisma',
  'db',
  'client',
  'this.prisma',
  'this.db',
  'this.client',
]);

/**
 * Legacy name-regex used as a fallback when AST resolution fails to
 * follow the receiver to a `new PrismaClient()` construction. Common
 * miss case: Next.js path-aliased imports like
 *
 *   import prisma from "@/lib/prisma";
 *   prisma.user.findMany();
 *
 * `getModuleSpecifierSourceFile()` returns null for `@/lib/prisma`
 * unless the orchestrator has registered the project's `paths`
 * mapping, so the AST chain breaks and the receiver looks like
 * 'unknown'. Falling back to the historical name regex
 * (`/^(this\.)?(prisma|db|client)$/`) keeps real-world Next.js +
 * Prisma codebases detected — at the cost of marking confidence
 * `inferred` instead of `direct`.
 */
const LEGACY_RECEIVER_NAME_PATTERN = /^(this\.)?(prisma|db|client)$/;

type AcceptedVia = 'ast' | 'regex';

/**
 * Returns `'ast'` when AST traversal proves the receiver is a
 * PrismaClient, `'regex'` when the AST chain broke (`'unresolved'`)
 * AND the receiver text matches a conventional Prisma binding name,
 * `null` otherwise.
 *
 * IMPORTANT: when the AST returns `'not-prisma'` (e.g. the receiver
 * resolves to `new MongoClient()`), we do NOT fall back to the regex.
 * The proof is negative — the conventional name `db` could legitimately
 * be a non-Prisma client in a mixed-ORM codebase, and emitting a
 * Prisma DatabaseInteraction for it would be a worse false positive
 * than the path-aliased miss the regex was meant to fix.
 */
interface AcceptanceResult {
  acceptedVia: AcceptedVia;
  /**
   * #322 — When the AST resolver took notable paths (HOF unwrap,
   * free-function factory, type-annotation walk), they're collected
   * here so the visitor can emit one `ConfidenceDecision` span per
   * trace. Multi-trace chains (e.g. `||`/`??` with both arms
   * resolving) emit one event per arm; empty array for plain
   * `new PrismaClient()` and regex fallback.
   */
  traces: ResolverTrace[];
}

function acceptPrismaReceiver(receiver: Node): AcceptanceResult | null {
  const traces: ResolverTrace[] = [];
  const kind = classifyPrismaReceiver(receiver as never, {
    onTrace: (t) => traces.push(t),
  });
  if (kind === 'client') return { acceptedVia: 'ast', traces };
  if (kind === 'not-prisma') return null;
  // kind === 'unresolved' — fall back to legacy name regex.
  if (LEGACY_RECEIVER_NAME_PATTERN.test(receiver.getText())) {
    return { acceptedVia: 'regex', traces: [] };
  }
  return null;
}

interface PrismaVisitorOptions {
  /**
   * DatabaseSystem id all tables in the current project belong to.
   * Comes from the `DatabaseSystem` node emitted by the schema
   * parser. `DatabaseTable` ids are content-addressed on
   * `(systemId, schema: null, modelName)`, so the visitor needs this
   * to produce edges that line up with the tables already committed.
   */
  readonly systemId: string;
}

/**
 * Build a `TsFrameworkVisitor` bound to a specific project's Prisma
 * `DatabaseSystem` id. Created by `PrismaPlugin` after
 * `onProjectLoaded` has discovered the schema.
 */
export function createPrismaVisitor(opts: PrismaVisitorOptions): TsFrameworkVisitor {
  const { systemId } = opts;

  return {
    language: 'ts',
    onNode(ctx, node) {
      // Fast bailout — onNode fires on every AST node. We care about
      // two shapes: a regular `CallExpression` (`prisma.user.findMany()`)
      // and a `TaggedTemplateExpression` (`prisma.$queryRaw\`...\``).
      let classification: Classification | null = null;
      if (Node.isCallExpression(node)) {
        classification = classifyCall(node);
      } else if (Node.isTaggedTemplateExpression(node)) {
        classification = classifyTaggedTemplate(node);
      } else {
        return;
      }
      if (!classification) return;

      // Module-top-level call sites (e.g. initialization in a config
      // file) have no enclosing function to attribute to. Skip them
      // so we don't emit a PERFORMED_BY edge pointing nowhere.
      const enclosing = ctx.enclosingFunction;
      if (!enclosing) return;

      if (classification.kind === 'raw') {
        // Raw queries — we cannot statically determine the target
        // table, so we emit an interaction with a synthetic target
        // id that does not correspond to any DatabaseTable the
        // schema parser emitted. Callers reading the graph will see
        // this as "operation: raw, no matching table" and can
        // escalate to AI analysis of the rawQuery literal.
        recordConfidenceDecision('prisma raw query — target table not statically resolvable', {
          'prisma.method': classification.method,
          'call.sourceLine': node.getStartLineNumber(),
        });
        const syntheticTableId = idFor.databaseTable({
          systemId,
          schema: null,
          name: '<raw>',
        });
        const interactionId = idFor.databaseInteraction({
          callSiteFunctionId: enclosing.id,
          operation: 'raw',
          targetTableId: syntheticTableId,
        });
        ctx.emitNode({
          nodeType: 'DatabaseInteraction',
          id: interactionId,
          callSiteFunctionId: enclosing.id,
          operation: 'raw',
          orm: 'prisma',
          rawQuery: truncate(node.getText(), 500),
          confidence: 'dynamic',
          evidence: buildEvidence(node, ctx.sourceFile.filePath, 'inferred'),
        });
        ctx.emitEdge({
          edgeType: 'PERFORMED_BY',
          from: interactionId,
          to: enclosing.id,
          sourceLine: node.getStartLineNumber(),
        });
        return;
      }

      // CRUD case — we know the model accessor and the method.
      const modelName = modelNameFromAccessor(classification.modelAccessor);
      const targetTableId = idFor.databaseTable({
        systemId,
        schema: null,
        name: modelName,
      });
      const interactionId = idFor.databaseInteraction({
        callSiteFunctionId: enclosing.id,
        operation: classification.operation,
        targetTableId,
      });

      // Confidence (#5/#6 + path-alias fallback):
      //   - AST-resolved receiver → `direct` (variable name irrelevant,
      //     proved to be `new PrismaClient()`).
      //   - Regex-fallback receiver → `inferred` (path-aliased
      //     import the AST chain couldn't follow; we accept based on
      //     the conventional binding name).
      const confidence: DatabaseInteractionConfidence =
        classification.acceptedVia === 'ast' ? 'direct' : 'inferred';

      if (classification.acceptedVia === 'ast' && !CANONICAL_RECEIVER_NAMES.has(classification.receiverText)) {
        recordConfidenceDecision('prisma receiver matched by AST resolution', {
          'prisma.receiver': classification.receiverText,
          'prisma.model': modelName,
          'prisma.method': classification.method,
          'call.sourceLine': node.getStartLineNumber(),
        });
      } else if (classification.acceptedVia === 'regex') {
        recordConfidenceDecision('prisma receiver matched by name fallback (AST chain unresolvable)', {
          'prisma.receiver': classification.receiverText,
          'prisma.model': modelName,
          'prisma.method': classification.method,
          'call.sourceLine': node.getStartLineNumber(),
        });
      }
      // #322 — Trace notable AST-resolver paths (HOF wrapper unwrap,
      // free-function factory call, type-annotation walk). Emitted
      // regardless of receiver name so we can measure real-world
      // hit-rate for each path independently. Multi-trace chains
      // (e.g. `||`/`??` with both arms resolving) emit one event
      // per trace.
      for (const trace of classification.traces) {
        recordConfidenceDecision(`prisma resolver path: ${trace}`, {
          'prisma.resolverPath': trace,
          'prisma.receiver': classification.receiverText,
          'prisma.model': modelName,
          'prisma.method': classification.method,
          'call.sourceLine': node.getStartLineNumber(),
        });
      }

      ctx.emitNode({
        nodeType: 'DatabaseInteraction',
        id: interactionId,
        callSiteFunctionId: enclosing.id,
        operation: classification.operation,
        orm: 'prisma',
        rawQuery: null,
        confidence,
        evidence: buildEvidence(node, ctx.sourceFile.filePath, classification.acceptedVia === 'ast' ? 'exact' : 'heuristic'),
      });

      // READS vs WRITES: READS carries filters; WRITES carries kind.
      // Our caller does not have access to a parsed `where` / `data`
      // argument in this pass, so we pass null/undefined defaults.
      // A future enrichment pass could extract selected columns from
      // the `select:` / `data:` arguments.
      if (classification.operation === 'read') {
        ctx.emitEdge({
          edgeType: 'READS',
          from: interactionId,
          to: targetTableId,
          columns: null,
          filters: null,
        });
      } else {
        ctx.emitEdge({
          edgeType: 'WRITES',
          from: interactionId,
          to: targetTableId,
          columns: null,
          kind: writesKindFor(classification.operation),
        });
      }
      ctx.emitEdge({
        edgeType: 'PERFORMED_BY',
        from: interactionId,
        to: enclosing.id,
        sourceLine: node.getStartLineNumber(),
      });
    },
  } satisfies TsFrameworkVisitor;
}

// ──────────────────────────────────────────────────────────────────────
// Call classification
// ──────────────────────────────────────────────────────────────────────

type CrudCall = {
  kind: 'crud';
  receiverText: string;
  modelAccessor: string;
  method: string;
  operation: DatabaseOperation;
  acceptedVia: AcceptedVia;
  traces: ResolverTrace[];
};

type RawCall = {
  kind: 'raw';
  receiverText: string;
  method: string;
  acceptedVia: AcceptedVia;
  traces: ResolverTrace[];
};

type Classification = CrudCall | RawCall;

/**
 * Inspect a `CallExpression` and return a classification if it looks
 * like a Prisma Client call. Returns `null` for anything we don't
 * recognize so the visitor can bail early.
 */
function classifyCall(call: CallExpression): Classification | null {
  const outer = call.getExpression();
  if (!Node.isPropertyAccessExpression(outer)) return null;

  const method = outer.getNameNode().getText();
  const middle = outer.getExpression();

  // Raw query shape: `prisma.$queryRaw\`...\`` — the method name
  // starts with `$` and the receiver is directly the Prisma client.
  if (RAW_METHODS.has(method)) {
    const accept = acceptPrismaReceiver(middle);
    if (!accept) return null;
    const receiverText = middle.getText();
    return { kind: 'raw', receiverText, method, acceptedVia: accept.acceptedVia, traces: accept.traces };
  }

  // CRUD shape: `prisma.user.findMany(...)` — middle is itself a
  // PropertyAccessExpression of the form `<receiver>.<modelAccessor>`.
  if (!Node.isPropertyAccessExpression(middle)) return null;

  const operation = CRUD_OPERATIONS.get(method);
  if (!operation) return null;

  const modelAccessor = middle.getNameNode().getText();
  const receiver = middle.getExpression();
  const accept = acceptPrismaReceiver(receiver);
  if (!accept) return null;
  const receiverText = receiver.getText();

  return {
    kind: 'crud',
    receiverText,
    modelAccessor,
    method,
    operation,
    acceptedVia: accept.acceptedVia,
    traces: accept.traces,
  };
}

/**
 * Classify a tagged template expression, e.g. `prisma.$queryRaw\`...\``.
 * Only raw methods (`$queryRaw`/`$executeRaw` and their `Unsafe`
 * variants) appear in this form for Prisma. Returns null for any
 * other tag.
 */
function classifyTaggedTemplate(node: TaggedTemplateExpression): Classification | null {
  const tag = node.getTag();
  if (!Node.isPropertyAccessExpression(tag)) return null;
  const method = tag.getNameNode().getText();
  if (!RAW_METHODS.has(method)) return null;
  const receiver = tag.getExpression();
  const accept = acceptPrismaReceiver(receiver);
  if (!accept) return null;
  const receiverText = receiver.getText();
  return { kind: 'raw', receiverText, method, acceptedVia: accept.acceptedVia, traces: accept.traces };
}

function writesKindFor(operation: DatabaseOperation): 'insert' | 'update' | 'upsert' | 'delete' {
  switch (operation) {
    case 'write':
      return 'insert';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    case 'upsert':
      return 'upsert';
    default:
      // Should not happen — callers only pass write-flavored operations.
      return 'update';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
