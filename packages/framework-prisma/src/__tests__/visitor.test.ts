import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  idFor,
  validateEdge,
  validateNode,
  type DatabaseInteraction,
  type PerformedByEdge,
  type ReadsEdge,
  type SchemaEdge,
  type SchemaNode,
  type WritesEdge,
} from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { resetObservability, initObservability } from '@veoable/observability';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { PrismaPlugin, PRISMA_PLUGIN_ID, modelNameFromAccessor } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/prisma');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

const POSTGRES_DB_ID = idFor.databaseSystem({ kind: 'postgres', name: 'db' });

function userTableId(): string {
  return idFor.databaseTable({ systemId: POSTGRES_DB_ID, schema: null, name: 'User' });
}

function postTableId(): string {
  return idFor.databaseTable({ systemId: POSTGRES_DB_ID, schema: null, name: 'Post' });
}

async function extract(fixture: string, file: string): Promise<NodeBatch> {
  const plugin = new PrismaPlugin();
  // onProjectLoaded sets _systemId and invalidates the visitor cache.
  plugin.onProjectLoaded({
    rootDir: fixturePath(fixture),
    packageJson: null,
    files: [],
  });
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(fixture) });
  return ts.extractFile(handle, file);
}

function interactionsByOperation(
  batch: { nodes: SchemaNode[] },
  operation: string
): DatabaseInteraction[] {
  return batch.nodes.filter(
    (n): n is DatabaseInteraction =>
      n.nodeType === 'DatabaseInteraction' && n.operation === operation
  );
}

function edgesOfType<T extends SchemaEdge['edgeType']>(
  batch: { edges: SchemaEdge[] },
  type: T
): Extract<SchemaEdge, { edgeType: T }>[] {
  return batch.edges.filter(
    (e): e is Extract<SchemaEdge, { edgeType: T }> => e.edgeType === type
  );
}

// ──────────────────────────────────────────────────────────────────────
// modelNameFromAccessor
// ──────────────────────────────────────────────────────────────────────

describe('modelNameFromAccessor', () => {
  it.each([
    ['user', 'User'],
    ['post', 'Post'],
    ['hTTPRequest', 'HTTPRequest'],
    ['pDFDocument', 'PDFDocument'],
    ['a', 'A'],
    ['', ''],
  ])('maps accessor %s → %s', (input, expected) => {
    expect(modelNameFromAccessor(input)).toBe(expected);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Canonical `prisma.*` CRUD detection
// ──────────────────────────────────────────────────────────────────────

describe('canonical `prisma.X.Y()` CRUD detection', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/handlers.ts');
  });

  it('every emitted node and edge passes canonical validation', () => {
    for (const node of batch.nodes) {
      if (
        node.nodeType === 'DatabaseInteraction' ||
        node.nodeType === 'APIEndpoint' ||
        node.nodeType === 'ClientSideAPICaller' ||
        node.nodeType === 'ClientSideProcess' ||
        node.nodeType === 'DatabaseSystem' ||
        node.nodeType === 'DatabaseTable' ||
        node.nodeType === 'DatabaseColumn'
      ) {
        expect(() => validateNode(node)).not.toThrow();
      }
    }
    for (const edge of batch.edges) expect(() => validateEdge(edge)).not.toThrow();
  });

  it('emits a DatabaseInteraction + READS edge for prisma.user.findMany()', () => {
    const reads = interactionsByOperation(batch, 'read');
    expect(reads.length).toBeGreaterThanOrEqual(3); // findMany + findUnique + findFirst/count
    const findManyInteraction = reads.find((r) => r.confidence === 'direct');
    expect(findManyInteraction).toBeDefined();
    expect(findManyInteraction!.orm).toBe('prisma');

    const readsEdges = edgesOfType(batch, 'READS') as ReadsEdge[];
    expect(readsEdges.some((e) => e.to === userTableId())).toBe(true);
  });

  it('emits DatabaseInteraction + WRITES edge with kind="insert" for prisma.user.create()', () => {
    const writes = interactionsByOperation(batch, 'write');
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const writesEdges = edgesOfType(batch, 'WRITES') as WritesEdge[];
    const insertToUser = writesEdges.find((e) => e.to === userTableId() && e.kind === 'insert');
    expect(insertToUser).toBeDefined();
  });

  it('classifies update, delete, and upsert correctly', () => {
    expect(interactionsByOperation(batch, 'update').length).toBeGreaterThanOrEqual(1);
    expect(interactionsByOperation(batch, 'delete').length).toBeGreaterThanOrEqual(1);
    expect(interactionsByOperation(batch, 'upsert').length).toBeGreaterThanOrEqual(1);

    const writesEdges = edgesOfType(batch, 'WRITES') as WritesEdge[];
    expect(writesEdges.some((e) => e.kind === 'update')).toBe(true);
    expect(writesEdges.some((e) => e.kind === 'delete')).toBe(true);
    expect(writesEdges.some((e) => e.kind === 'upsert')).toBe(true);
  });

  it('emits a PERFORMED_BY edge for every DatabaseInteraction', () => {
    const interactions = batch.nodes.filter(
      (n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction'
    );
    const performed = edgesOfType(batch, 'PERFORMED_BY') as PerformedByEdge[];
    for (const interaction of interactions) {
      expect(performed.some((e) => e.from === interaction.id)).toBe(true);
    }
  });

  it('uses the correct DatabaseTable id for a multi-model fixture (User and Post)', () => {
    const writesEdges = edgesOfType(batch, 'WRITES') as WritesEdge[];
    const readsEdges = edgesOfType(batch, 'READS') as ReadsEdge[];
    const allTableTargets = new Set<string>([
      ...writesEdges.map((e) => e.to),
      ...readsEdges.map((e) => e.to),
    ]);
    expect(allTableTargets.has(userTableId())).toBe(true);
    expect(allTableTargets.has(postTableId())).toBe(true);
  });

  it('every CRUD interaction has orm="prisma"', () => {
    const interactions = batch.nodes.filter(
      (n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction'
    );
    for (const interaction of interactions) {
      expect(interaction.orm).toBe('prisma');
    }
  });

  it('direct prisma receiver produces confidence="direct"', () => {
    const direct = interactionsByOperation(batch, 'read').filter((i) => i.confidence === 'direct');
    expect(direct.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Raw queries
// ──────────────────────────────────────────────────────────────────────

describe('raw queries ($queryRaw / $executeRaw)', () => {
  it('emits a DatabaseInteraction with operation="raw" and confidence="dynamic"', async () => {
    const batch = await extract('client-usage', 'src/handlers.ts');
    const raws = interactionsByOperation(batch, 'raw');
    expect(raws).toHaveLength(1);
    expect(raws[0].confidence).toBe('dynamic');
    expect(raws[0].rawQuery).toContain('SELECT * FROM "User"');
  });

  it('raw interaction has a PERFORMED_BY edge but no READS/WRITES edge', async () => {
    const batch = await extract('client-usage', 'src/handlers.ts');
    const raws = interactionsByOperation(batch, 'raw');
    const rawId = raws[0].id;

    const performed = edgesOfType(batch, 'PERFORMED_BY') as PerformedByEdge[];
    expect(performed.some((e) => e.from === rawId)).toBe(true);

    const reads = edgesOfType(batch, 'READS') as ReadsEdge[];
    const writes = edgesOfType(batch, 'WRITES') as WritesEdge[];
    expect(reads.some((e) => e.from === rawId)).toBe(false);
    expect(writes.some((e) => e.from === rawId)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// AST-resolved receivers (db, client, this.prisma, and non-conventional
// names like `database`, `orm`, `this.storage`) — #5/#6
// ──────────────────────────────────────────────────────────────────────

describe('AST-resolved receivers', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/aliases.ts');
  });

  it('detects db.user.findMany() with confidence="direct"', () => {
    const reads = interactionsByOperation(batch, 'read');
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.every((r) => r.confidence === 'direct')).toBe(true);
  });

  it('detects all four module-level receivers (db, client, database, orm)', () => {
    // The fixture exports four module-level functions, each calling
    // `<receiver>.user.findMany()` on a different binding. AST
    // resolution should accept all four.
    const reads = interactionsByOperation(batch, 'read');
    // 4 module-level reads + 1 class-method read (UserService.getAll)
    // + 1 class-method read (CustomService.list) = 6 reads minimum.
    expect(reads.length).toBeGreaterThanOrEqual(6);
  });

  it('detects this.prisma.user.findMany() with confidence="direct"', () => {
    // The class field `private prisma = new PrismaClient()` is
    // AST-resolved through `this.prisma` to the field's initializer.
    const reads = interactionsByOperation(batch, 'read');
    expect(reads.every((r) => r.confidence === 'direct')).toBe(true);
  });

  it('detects this.storage.user.findMany() — non-conventional class field', () => {
    // CustomService has `private storage = new PrismaClient()`. The
    // prior name-regex (which required `prisma|db|client`) would
    // have dropped this; AST resolution accepts it.
    const reads = interactionsByOperation(batch, 'read');
    // At least one read is from CustomService.list — the class
    // method that uses `this.storage`.
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('the class method call this.prisma.user.create() emits a WRITES edge', () => {
    const writes = edgesOfType(batch, 'WRITES') as WritesEdge[];
    const userWrites = writes.filter((e) => e.to === userTableId() && e.kind === 'insert');
    expect(userWrites.length).toBeGreaterThan(0);
  });

  // #312 — singleton-with-fallback patterns common in Next.js + Prisma:
  //   const prisma = global.prisma || new PrismaClient();
  // AST resolver unwraps `||`/`??`/ternary and finds the PrismaClient
  // arm. Result: `direct` confidence, not `inferred`.
  it('singleton with || fallback (Next.js pattern) resolves to direct confidence', () => {
    const reads = interactionsByOperation(batch, 'read');
    const directs = reads.filter((r) => r.confidence === 'direct');
    // 4 module-level + 2 class-method + 3 singleton variants = 9 minimum.
    expect(directs.length).toBeGreaterThanOrEqual(9);
  });

  // #317 — higher-order memoize/remember wrappers (documenso pattern).
  // The resolver follows into the wrapper's last argument (callback)
  // and recurses on the callback's return expression.
  it('higher-order remember/memoize wrappers resolve to direct confidence', () => {
    const reads = interactionsByOperation(batch, 'read');
    const directs = reads.filter((r) => r.confidence === 'direct');
    // Three additional wrapper-bound singletons:
    //   - listViaRemember (concise-body arrow inside `remember(...)`)
    //   - listViaMemoize (concise-body arrow inside `memoize(...)`)
    //   - listViaBlockBody (block-body callback with intermediate logic)
    // → 9 (prior) + 3 (new) = 12 minimum.
    expect(directs.length).toBeGreaterThanOrEqual(12);
  });

  // #320 — generalized expression unwraps: descendants walk for
  // all returns + AsExpression + NonNullExpression + AwaitExpression.
  it('block body with early `return new PrismaClient()` resolves to direct (#320)', () => {
    // earlyReturnSingleton's factory body is:
    //   if (isProduction) return new PrismaClient();
    //   return mockClient;
    // Pre-#320 the last-return-wins rule resolved to `mockClient`
    // (unresolved) and missed the constructor in the early arm.
    const reads = interactionsByOperation(batch, 'read');
    const directs = reads.filter((r) => r.confidence === 'direct');
    // 12 prior + 3 new (early-return, cast, non-null) = 15 min.
    // #323 — once await + free-fn-call resolution is in place,
    // loadAsync also resolves, bringing the count to 16+.
    expect(directs.length).toBeGreaterThanOrEqual(15);
  });

  // #323 — `await getPrisma()` where getPrisma() is a free function
  // whose body returns `new PrismaClient()` should resolve to direct.
  it('await + free-function-call returns one level deep (#323)', () => {
    const reads = interactionsByOperation(batch, 'read');
    const directs = reads.filter((r) => r.confidence === 'direct');
    // 12 prior + 3 new (early-return, cast, non-null) + 1 #323 (loadAsync) = 16.
    expect(directs.length).toBeGreaterThanOrEqual(16);
  });

  it('AsExpression / NonNullExpression / AwaitExpression do not crash; resolve where possible', () => {
    // listViaCast / listViaNonNull — both produce direct reads.
    // loadAsync — does not produce an interaction (await -> CallExpression
    // -> FunctionDeclaration return is unresolvable today), but the
    // analyzer must not throw while walking it.
    const reads = interactionsByOperation(batch, 'read');
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(['direct', 'inferred']).toContain(r.confidence);
    }
  });

  // #326 — NestJS DI-injected services. PrismaService extends
  // PrismaClient; the consumer's constructor parameter property
  // type-annotation is followed to the extending class.
  it('NestJS DI parameter property (PrismaService extends PrismaClient) → direct', async () => {
    const diBatch = await extract('client-usage', 'src/nestjs-di.ts');
    const reads = interactionsByOperation(diBatch, 'read');
    const userReads = reads.filter((r) => r.confidence === 'direct');
    // 2 read sites: UserDIService.list (`this.prismaService.user.findMany`)
    // and UserDIService2.list (`this.prisma.user.findMany`). Both should
    // be `direct` via the new type-annotation fallback.
    expect(userReads.length).toBeGreaterThanOrEqual(2);
  });

  it('NestJS DI write (this.prismaService.user.create) → direct', async () => {
    const diBatch = await extract('client-usage', 'src/nestjs-di.ts');
    const writes = interactionsByOperation(diBatch, 'write');
    const userWrites = writes.filter((w) => w.confidence === 'direct');
    expect(userWrites.length).toBeGreaterThanOrEqual(1);
  });

  it('cross-file NestJS DI (mirroring ghostfolio): direct confidence', async () => {
    const xfBatch = await extract('client-usage', 'src/nestjs-di-cross-file.ts');
    const reads = interactionsByOperation(xfBatch, 'read');
    const directs = reads.filter((r) => r.confidence === 'direct');
    expect(directs.length).toBeGreaterThanOrEqual(1);
  });

  it('NestJS DI mixed-ORM negative (db: NotPrismaService extends MockDb) is NOT detected', async () => {
    // `db` matches the legacy regex, but the type annotation
    // resolves to a class extending MockDb — definitive negative.
    // Without 'not-prisma' propagation through the type-annotation
    // path, the regex fallback would mis-classify this. The
    // fixture has 3 legitimate interactions (UserDIService.list,
    // UserDIService.create, UserDIService2.list); MixedOrmService.list
    // must NOT add a fourth.
    const diBatch = await extract('client-usage', 'src/nestjs-di.ts');
    const interactions = diBatch.nodes.filter(
      (n) => n.nodeType === 'DatabaseInteraction',
    );
    expect(interactions.length).toBe(3);
  });

  // #321 review C1 — nested-callable skip-list correctness.
  // `leakyAccessorSingleton`'s factory returns a plain object whose
  // getter `cached` constructs a PrismaClient. Pre-fix, the
  // accessor's return leaked and the singleton was classified
  // `'client'` → `leakyAccessorSingleton.user.findMany()` would
  // emit a spurious READS edge to User. Post-fix the resolver
  // skips `GetAccessorDeclaration` so the factory's actual return
  // (`helper`, an object literal) is what gets classified.
  it('does not leak return statements from nested accessors / constructors into the outer classification', () => {
    const reads = interactionsByOperation(batch, 'read');
    // Find any read attributed to listViaLeakyAccessor's enclosing
    // function. Pre-fix this would be a populated set; post-fix
    // it must be empty.
    const fns = batch.nodes.filter((n) => n.nodeType === 'FunctionDefinition');
    const leaky = fns.find((f) => f.name === 'listViaLeakyAccessor');
    expect(leaky).toBeDefined();
    const spurious = reads.filter((r) => r.callSiteFunctionId === leaky!.id);
    expect(spurious).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #307 — `$extends(...)`-wrapped receivers
//
// Prisma's official extension API returns a wrapped client whose
// model accessors mirror the inner client. The resolver should peel
// one `.$extends(...)` layer at a time until it reaches a
// recognizable inner expression. The fixture exercises three flavors:
//   1. direct: `new PrismaClient().$extends(ext).<model>.<op>()`
//   2. chained: `new PrismaClient().$extends().$extends()`
//   3. identifier-receiver: factory returns the wrapped client
// ──────────────────────────────────────────────────────────────────────

describe('#307 — $extends-wrapped receivers', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/dollar-extends.ts');
  });

  it('resolves `new PrismaClient().$extends(ext)` as direct', () => {
    const reads = interactionsByOperation(batch, 'read');
    const direct = reads.filter((r) => r.confidence === 'direct');
    // Three call sites exercising different $extends shapes; each
    // should land on a direct read against User.
    expect(direct.length).toBeGreaterThanOrEqual(3);
    const readsEdges = edgesOfType(batch, 'READS') as ReadsEdge[];
    expect(readsEdges.some((e) => e.to === userTableId())).toBe(true);
  });

  it('peels chained $extends().$extends() down to the inner new PrismaClient()', () => {
    const reads = interactionsByOperation(batch, 'read');
    // listViaChainedExtends specifically uses two layers; if either
    // peel didn't recurse, the chained variant would resolve to
    // unresolved / inferred. Direct count >=3 implies all three
    // variants (incl. chained) resolved.
    expect(reads.filter((r) => r.confidence === 'direct').length).toBeGreaterThanOrEqual(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #307 — Function-parameter receivers (non-class DI)
//
// The receiver lands on a `ParameterDeclaration`. Pre-#307 the
// resolver had no branch for this and returned `'unresolved'` even
// when the parameter type was `PrismaClient` directly. The fixture
// covers four shapes:
//   1. plain `PrismaClient` parameter
//   2. class extending PrismaClient as the parameter type
//   3. `ReturnType<typeof factory>` type alias wrapping a
//      `$extends` chain (test-code-comprehension's pattern)
//   4. `type DbClient = PrismaClient` simple alias
// ──────────────────────────────────────────────────────────────────────

describe('#307 — function-parameter receivers', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/param-di.ts');
  });

  it('resolves `prisma: PrismaClient` parameter as direct', () => {
    const reads = interactionsByOperation(batch, 'read');
    const direct = reads.filter((r) => r.confidence === 'direct');
    // Four exported handlers, each issuing exactly one read.
    expect(direct.length).toBeGreaterThanOrEqual(4);
  });

  it('resolves `prisma: PrismaService` (extends PrismaClient) parameter as direct', () => {
    // If the extends-chain resolution wasn't reached for parameters,
    // listUsersExtending would land at unresolved/inferred. The
    // count assertion above already guards this; pinning the
    // PERFORMED_BY edge ensures attribution lands on the
    // right function.
    const performed = edgesOfType(batch, 'PERFORMED_BY') as PerformedByEdge[];
    expect(performed.length).toBeGreaterThanOrEqual(4);
  });

  it('resolves `prisma: ReturnType<typeof extendPrismaClient>` parameter as direct', () => {
    // The factory `extendPrismaClient` returns `prisma.$extends(...)`
    // which itself recurses to `new PrismaClient()`. The whole chain
    // (param type-annotation → ReturnType<typeof X> → function return
    // → $extends recursion → new PrismaClient) must resolve.
    const reads = interactionsByOperation(batch, 'read');
    const direct = reads.filter((r) => r.confidence === 'direct');
    expect(direct.length).toBeGreaterThanOrEqual(4);
  });

  it('resolves `type DbClient = PrismaClient` alias parameter as direct', () => {
    // Pure type-alias chain (no factory) — the type identifier
    // resolves to a TypeAliasDeclaration whose right-hand side is
    // another TypeReference to PrismaClient.
    const reads = interactionsByOperation(batch, 'read');
    expect(reads.filter((r) => r.confidence === 'direct').length).toBeGreaterThanOrEqual(4);
  });

  // #307 — Critical real-world variant: type alias lives in a
  // DIFFERENT file from the consumer, imported via `import type`.
  // Mirrors test-code-comprehension's actual layout. ts-morph
  // must follow the type-only import to the alias, then through
  // ReturnType<typeof X> to the factory's return.
  it('resolves cross-file `import type { ExtendedPrismaClient }` parameter as direct', async () => {
    const xfBatch = await extract('client-usage', 'src/param-di-cross-file.ts');
    const reads = interactionsByOperation(xfBatch, 'read');
    const writes = interactionsByOperation(xfBatch, 'write');
    const direct = reads.filter((r) => r.confidence === 'direct');
    const directWrites = writes.filter((w) => w.confidence === 'direct');
    expect(direct.length).toBeGreaterThanOrEqual(1);
    expect(directWrites.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Path-aliased receivers (regex fallback) — Next.js / `@/lib/prisma`
// case where ts-morph can't follow the import. The AST chain breaks,
// so we fall back to the legacy name regex with `inferred` confidence.
// ──────────────────────────────────────────────────────────────────────

describe('path-aliased receiver fallback', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/path-aliased.ts');
  });

  it('detects prisma.user.findMany() with confidence="inferred" when AST resolution fails', () => {
    const reads = interactionsByOperation(batch, 'read');
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.every((r) => r.confidence === 'inferred')).toBe(true);
  });

  it('detects prisma.post.create() write when AST resolution fails', () => {
    const writes = interactionsByOperation(batch, 'write');
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes.every((w) => w.confidence === 'inferred')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #371 — `globalForPrisma.prisma ?? prismaClientSingleton()` chain
//
// Canonical Next.js + Prisma "hot-reload guard" singleton. Each piece
// is supported individually (`??` per #312, free-fn factory per
// #323/#325). Combined cross-file the chain has to thread through all
// three at once. The fixture exercises the producer-side declaration
// directly (in the same file as the consumer); the cross-file/cross-
// package variant requires a separate ts-morph project setup.
// ──────────────────────────────────────────────────────────────────────

describe('#371 — `??` + free-fn-factory chain', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/coalesce-factory-singleton.ts');
  });

  it('resolves `globalForPrisma.prisma ?? buildClient()` to direct (same file)', () => {
    const reads = interactionsByOperation(batch, 'read');
    const direct = reads.filter((r) => r.confidence === 'direct');
    // listUsersViaCoalesce calls coalescedPrisma.user.findMany().
    // The receiver `coalescedPrisma` traces back to a `??` whose
    // right arm is `buildClient()` — a free-function call whose
    // body returns `new PrismaClient()`. Must resolve to direct.
    expect(direct).toHaveLength(1);
  });

  // Cross-file variant — formbricks/rallly real shape. Producer
  // exports `prisma = globalForPrisma.prisma ?? prismaClientSingleton()`;
  // consumer imports `{ prisma }` and calls `prisma.user.findMany()`.
  // Pre-fix: receiver lands at `'unresolved'` even though every
  // individual piece (`??`, free-fn factory, cross-file import) is
  // supported. Post-fix: resolves to `direct`.
  it('resolves cross-file coalesce-singleton import (formbricks pattern, same package)', async () => {
    const xfBatch = await extract('client-usage', 'src/coalesce-consumer.ts');
    const reads = interactionsByOperation(xfBatch, 'read');
    const direct = reads.filter((r) => r.confidence === 'direct');
    expect(direct).toHaveLength(1);
  });

  // Cross-PACKAGE variant — same shape but consumer and producer
  // live in different workspace packages connected via tsconfig
  // path aliases. This is the actual formbricks shape: consumer in
  // `apps/web/...` imports `import { prisma } from "@formbricks/database"`
  // which resolves to a sibling package's `src/client.ts`.
  it('resolves cross-PACKAGE coalesce-singleton via path alias', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-371-xpkg-'));
    try {
      // Layout:
      //   packages/database/src/client.ts   — coalesce-singleton producer
      //   packages/database/src/index.ts    — re-exports prisma
      //   apps/web/src/handlers.ts          — consumer via "@scope/database"
      //   apps/web/tsconfig.json            — paths: "@scope/database" → ../../packages/database/src
      await fs.mkdir(path.join(tmp, 'packages/database/src'), { recursive: true });
      await fs.mkdir(path.join(tmp, 'apps/web/src'), { recursive: true });

      // Local PrismaClient stub (same shape as the client-usage fixture).
      await fs.writeFile(
        path.join(tmp, 'packages/database/src/prisma-client.ts'),
        `export class PrismaClient {
  user = { findMany: async () => [] as Array<{ id: number }> };
}
`,
      );

      // Producer module — the formbricks pattern.
      await fs.writeFile(
        path.join(tmp, 'packages/database/src/client.ts'),
        `import { PrismaClient } from './prisma-client.js';

const prismaClientSingleton = (): PrismaClient => {
  return new PrismaClient();
};

declare const globalForPrisma: { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? prismaClientSingleton();
`,
      );

      // Barrel re-export.
      await fs.writeFile(
        path.join(tmp, 'packages/database/src/index.ts'),
        `export { prisma } from './client.js';
`,
      );

      // tsconfig with path alias.
      await fs.writeFile(
        path.join(tmp, 'apps/web/tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: false,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
            baseUrl: '.',
            paths: {
              '@scope/database': ['../../packages/database/src/index.ts'],
            },
          },
          include: ['src'],
        }, null, 2),
      );

      // Consumer — the formbricks `apps/web/.../X.ts` shape.
      await fs.writeFile(
        path.join(tmp, 'apps/web/src/handlers.ts'),
        `import { prisma } from "@scope/database";

export async function listUsers() {
  return prisma.user.findMany();
}
`,
      );

      // Set up the plugin + lang-ts as the orchestrator would.
      const plugin = new PrismaPlugin();
      // No schema in this fixture — we only care about receiver
      // resolution, not table extraction. Skip onProjectLoaded by
      // pre-seeding a fake systemId? Better: call onProjectLoaded
      // with the rootDir; with no schema present the visitor is a
      // no-op. So we add a minimal schema.
      const schemaPath = path.join(tmp, 'packages/database/prisma/schema.prisma');
      await fs.mkdir(path.dirname(schemaPath), { recursive: true });
      await fs.writeFile(
        schemaPath,
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
          'model User {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );

      // Seed the plugin with the workspace's schema.
      plugin.onProjectLoaded({
        rootDir: path.join(tmp, 'apps/web'),
        packageJson: null,
        files: [],
        frameworkDiscoveries: { [PRISMA_PLUGIN_ID]: [schemaPath] },
      });

      const ts = new TsLanguagePlugin();
      ts.registerVisitor(plugin.visitor);

      // Load apps/web with the synthesized path alias.
      const handle = await ts.loadProject({
        rootDir: path.join(tmp, 'apps/web'),
        compilerPaths: {
          '@scope/database': [path.join(tmp, 'packages/database/src/index.ts')],
        },
      });
      const batch = await ts.extractFile(handle, 'src/handlers.ts');

      const reads = interactionsByOperation(batch, 'read');
      const direct = reads.filter((r) => r.confidence === 'direct');
      expect(direct.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// #368 — `export default global.prisma` (typebot.io pattern)
//
// The receiver `global.prisma` has no traceable initializer through
// ordinary symbol resolution; the value lives at a SEPARATE
// assignment expression elsewhere in the same module. The resolver
// scans the enclosing file for `global.<X> = <rhs>` / `globalThis.<X> = <rhs>`
// assignments and merges their classifications.
// ──────────────────────────────────────────────────────────────────────

describe('#368 — global / globalThis property assignment chain', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/global-default-export.ts');
  });

  it('resolves `global.prisma` via the `global.prisma = new PrismaClient()` assignment', () => {
    const reads = interactionsByOperation(batch, 'read');
    const direct = reads.filter((r) => r.confidence === 'direct');
    // Two read functions in the fixture, exactly:
    //   - listUsersViaGlobal: global.prisma.user.findMany()
    //   - listUsersViaGlobalThis: globalThis.db.user.findMany()
    expect(direct).toHaveLength(2);
  });

  it('handles globalThis variant the same way as global', () => {
    const reads = interactionsByOperation(batch, 'read');
    const direct = reads.filter((r) => r.confidence === 'direct');
    // Both function calls must resolve. If only one resolved we'd
    // see direct.length === 1.
    expect(direct).toHaveLength(2);
  });

  // Cross-file variant — typebot.io's actual shape:
  // producer has `export default global.prisma`; consumer does
  // `import prisma from "..."` and calls `prisma.user.findMany()`.
  it('resolves cross-file `import prisma from "..."` via ExportAssignment of `global.prisma`', async () => {
    const xfBatch = await extract('client-usage', 'src/global-default-consumer.ts');
    const reads = interactionsByOperation(xfBatch, 'read');
    const direct = reads.filter((r) => r.confidence === 'direct');
    expect(direct).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negative cases — shapes that look prisma-ish but aren't
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/negatives.ts');
  });

  it('does not emit an interaction for an unknown CRUD method on a Prisma receiver', () => {
    // `prisma.user.fakeMethod()` — method not in CRUD whitelist.
    const interactions = batch.nodes.filter((n) => n.nodeType === 'DatabaseInteraction');
    // Also should not emit for `prisma[modelName].findMany()` — element access.
    // Also should not emit for `something.user.findMany()` — non-Prisma receiver.
    // Also should not emit for `[1,2,3].map(...)`.
    // Also should not emit for `db.user.findMany()` where AST proves `db = new MongoClient()`.
    expect(interactions).toHaveLength(0);
  });

  it('does not emit for `db = new MongoClient()` even though `db` matches the legacy name regex (mixed-ORM guard)', () => {
    // Critical: the receiver text `db` is in the legacy regex
    // alphabet, so a naive fallback would emit a Prisma interaction.
    // The 3-valued resolver returns `'not-prisma'` — the visitor
    // must NOT fall back to the regex.
    const interactions = batch.nodes.filter((n) => n.nodeType === 'DatabaseInteraction');
    expect(interactions).toHaveLength(0);
  });

  it('does not emit for `remember("mongo", () => new MongoClient())` (HOF-wrapped mixed-ORM guard)', () => {
    // The 3-valued resolver must propagate `'not-prisma'` through
    // the HOF unwrap. Without that propagation, a future refactor
    // could silently swallow the negative proof and the regex
    // fallback would re-emit a false positive — exactly the
    // mixed-ORM regression #317's negative-proof check exists to prevent.
    const interactions = batch.nodes.filter((n) => n.nodeType === 'DatabaseInteraction');
    expect(interactions).toHaveLength(0);
  });

  it('emits no READS/WRITES/PERFORMED_BY edges in the negative fixture', () => {
    expect(edgesOfType(batch, 'READS')).toHaveLength(0);
    expect(edgesOfType(batch, 'WRITES')).toHaveLength(0);
    expect(edgesOfType(batch, 'PERFORMED_BY')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// PrismaPlugin.onProjectLoaded + visitor lifecycle
// ──────────────────────────────────────────────────────────────────────

describe('PrismaPlugin.onProjectLoaded', () => {
  it('returns the same schema batch extractSchemas would', () => {
    const plugin = new PrismaPlugin();
    const ctx = {
      rootDir: fixturePath('postgres-basic'),
      packageJson: null,
      files: [],
    };
    const fromHook = plugin.onProjectLoaded(ctx);
    const fromDirect = plugin.extractSchemas(ctx.rootDir);
    // Edge arrays may be in slightly different insertion order, so
    // compare by counts + content as a set.
    expect(fromHook.nodes.length).toBe(fromDirect.nodes.length);
    expect(fromHook.edges.length).toBe(fromDirect.edges.length);
  });

  it('caches the DatabaseSystem id so the visitor becomes non-no-op', async () => {
    const plugin = new PrismaPlugin();
    // Before onProjectLoaded, the visitor is a no-op.
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const preHandle = await ts.loadProject({ rootDir: fixturePath('client-usage') });
    const preBatch = await ts.extractFile(preHandle, 'src/handlers.ts');
    expect(preBatch.nodes.filter((n) => n.nodeType === 'DatabaseInteraction')).toEqual([]);
  });

  it('after onProjectLoaded, the visitor emits DatabaseInteraction nodes', async () => {
    const plugin = new PrismaPlugin();
    plugin.onProjectLoaded({
      rootDir: fixturePath('client-usage'),
      packageJson: null,
      files: [],
    });
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const handle = await ts.loadProject({ rootDir: fixturePath('client-usage') });
    const batch = await ts.extractFile(handle, 'src/handlers.ts');
    const interactions = batch.nodes.filter((n) => n.nodeType === 'DatabaseInteraction');
    expect(interactions.length).toBeGreaterThan(0);
  });

  // #334 — Cross-package activation. When rootDir has no schema but
  // workspaceRoot does, the plugin still activates and adopts the
  // workspace's systemId.
  it('#334 — appliesTo + onProjectLoaded use workspaceRoot when rootDir has no schema', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-x-pkg-'));
    try {
      // Workspace layout: schema in packages/prisma/, consumer in apps/web/.
      await fs.mkdir(path.join(tmp, 'packages/prisma'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'packages/prisma/schema.prisma'),
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
          'generator client {',
          '  provider = "prisma-client-js"',
          '}',
          '',
          'model User {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );
      await fs.mkdir(path.join(tmp, 'apps/web'), { recursive: true });

      const plugin = new PrismaPlugin();
      // appliesTo: rootDir is apps/web (no schema), but workspaceRoot has one.
      const applies = plugin.appliesTo({
        rootDir: path.join(tmp, 'apps/web'),
        workspaceRoot: tmp,
        packageJson: null,
        files: [],
      });
      expect(applies).toBe(true);

      // onProjectLoaded: adopts the workspace schema's DatabaseSystem id.
      const batch = plugin.onProjectLoaded({
        rootDir: path.join(tmp, 'apps/web'),
        workspaceRoot: tmp,
        packageJson: null,
        files: [],
      });
      const system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
      expect(system).toBeDefined();
      expect(system!.id).toMatch(/^DatabaseSystem:/);

      // And the visitor is no longer a no-op.
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(plugin.visitor);
      // (We can't extract a file in this test without setting up a
      // consumer that imports the prisma client, but the visitor's
      // non-no-op state is what matters for the activation contract.)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('#334 — appliesTo returns false when neither rootDir nor workspaceRoot has a schema (and no deps)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-no-prisma-'));
    try {
      await fs.mkdir(path.join(tmp, 'apps/web'), { recursive: true });
      const plugin = new PrismaPlugin();
      const applies = plugin.appliesTo({
        rootDir: path.join(tmp, 'apps/web'),
        workspaceRoot: tmp,
        packageJson: null,
        files: [],
      });
      expect(applies).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // #348 — A `.prisma` file that is neither named `schema.prisma`
  // nor inside a `prisma/` directory must NOT cause activation. Test
  // fixtures and unrelated artefacts scattered through a monorepo are
  // the motivating false-positive class.
  it('#348 — appliesTo ignores stray .prisma files outside a prisma/ directory', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-stray-prisma-'));
    try {
      // A `fixtures.prisma` at workspace root with no `prisma/` parent.
      await fs.mkdir(path.join(tmp, 'apps/web'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'fixtures.prisma'), '// stray test fixture\n');
      const plugin = new PrismaPlugin();
      const applies = plugin.appliesTo({
        rootDir: path.join(tmp, 'apps/web'),
        workspaceRoot: tmp,
        packageJson: null,
        files: [],
      });
      expect(applies).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // #348 — Counter-test: a non-canonically-named `.prisma` file
  // INSIDE a `prisma/` directory should still activate (some users
  // shard their schema or use `prisma/extensions.prisma`).
  it('#348 — appliesTo still activates for .prisma files inside a prisma/ directory', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-prisma-dir-'));
    try {
      // No `schema.prisma`, but a `prisma/extensions.prisma`.
      await fs.mkdir(path.join(tmp, 'packages/prisma'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'packages/prisma/extensions.prisma'),
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
        ].join('\n'),
      );
      await fs.mkdir(path.join(tmp, 'apps/web'), { recursive: true });
      const plugin = new PrismaPlugin();
      const applies = plugin.appliesTo({
        rootDir: path.join(tmp, 'apps/web'),
        workspaceRoot: tmp,
        packageJson: null,
        files: [],
      });
      expect(applies).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // #344 — orchestrator pre-discovery contract.
  //
  // When the CLI's `project analyze` runs, it scans the workspace once
  // for canonical Prisma schemas and threads the result through
  // `ProjectContext.frameworkDiscoveries[PRISMA_PLUGIN_ID]`. The plugin must:
  //   1. Skip its own scan when the discovery key is set (any value)
  //   2. Treat an empty array as "scanned and found nothing"
  //   3. Use the FIRST schema's parent dir as the extraction root
  //      when the list is non-empty
  it('#344 — appliesTo trusts orchestrator frameworkDiscoveries (non-empty → true)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-prediscovered-'));
    try {
      await fs.mkdir(path.join(tmp, 'packages/prisma'), { recursive: true });
      const schemaPath = path.join(tmp, 'packages/prisma/schema.prisma');
      await fs.writeFile(
        schemaPath,
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
          'model User {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );
      await fs.mkdir(path.join(tmp, 'apps/web'), { recursive: true });

      const plugin = new PrismaPlugin();
      const applies = plugin.appliesTo({
        rootDir: path.join(tmp, 'apps/web'),
        // workspaceRoot intentionally omitted — only the
        // pre-discovered list should drive activation here.
        packageJson: null,
        files: [],
        frameworkDiscoveries: { [PRISMA_PLUGIN_ID]: [schemaPath] },
      });
      expect(applies).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('#344 — appliesTo respects an explicit empty discovery list (orchestrator scanned, found none)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-prediscovered-empty-'));
    try {
      // workspaceRoot DOES contain a schema, but the orchestrator
      // says "I scanned and found none." The plugin must trust the
      // orchestrator (e.g., when the orchestrator filtered the list
      // for some reason) rather than falling through to its own scan.
      await fs.mkdir(path.join(tmp, 'packages/prisma'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'packages/prisma/schema.prisma'),
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
        ].join('\n'),
      );
      await fs.mkdir(path.join(tmp, 'apps/web'), { recursive: true });

      const plugin = new PrismaPlugin();
      const applies = plugin.appliesTo({
        rootDir: path.join(tmp, 'apps/web'),
        workspaceRoot: tmp,
        packageJson: null,
        files: [],
        frameworkDiscoveries: { [PRISMA_PLUGIN_ID]: [] },
      });
      expect(applies).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('#344 — onProjectLoaded consumes pre-discovered schema without rescanning workspaceRoot', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-prediscovered-load-'));
    try {
      await fs.mkdir(path.join(tmp, 'packages/prisma'), { recursive: true });
      const schemaPath = path.join(tmp, 'packages/prisma/schema.prisma');
      await fs.writeFile(
        schemaPath,
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
          'model User {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );
      await fs.mkdir(path.join(tmp, 'apps/web'), { recursive: true });

      const plugin = new PrismaPlugin();
      // No workspaceRoot — the plugin would have nothing to scan
      // on its own. The pre-discovered list is the ONLY way it
      // finds the schema. Tests that the orchestrator-supplied
      // path is what drives discovery, not workspaceRoot scanning.
      const batch = plugin.onProjectLoaded({
        rootDir: path.join(tmp, 'apps/web'),
        packageJson: null,
        files: [],
        frameworkDiscoveries: { [PRISMA_PLUGIN_ID]: [schemaPath] },
      });
      const system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
      expect(system).toBeDefined();
      expect(system!.id).toMatch(/^DatabaseSystem:/);
      // And a model node landed in the batch.
      expect(batch.nodes.some((n) => n.nodeType === 'DatabaseTable')).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // #344 — precedence: a schema present LOCALLY in rootDir wins
  // over any orchestrator-supplied list. This pins the contract
  // documented in `onProjectLoaded`'s JSDoc.
  it('#344 — local rootDir schema takes precedence over orchestrator discovery', () => {
    const plugin = new PrismaPlugin();
    const localSystemId = idFor.databaseSystem({ kind: 'postgres', name: 'db' });
    // postgres-basic fixture has its own `prisma/schema.prisma`.
    // Even when we pass a different schema via the orchestrator
    // discovery channel, the local one should drive the extraction
    // (so the systemId matches the local schema, not the one we
    // tried to inject).
    const batch = plugin.onProjectLoaded({
      rootDir: fixturePath('postgres-basic'),
      packageJson: null,
      files: [],
      // Point at the mongodb fixture's schema — if precedence were
      // wrong, the resulting system kind would be `mongodb`.
      frameworkDiscoveries: {
        [PRISMA_PLUGIN_ID]: [
          path.join(fixturePath('mongodb-basic'), 'prisma', 'schema.prisma'),
        ],
      },
    });
    const system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
    expect(system).toBeDefined();
    expect(system!.id).toBe(localSystemId);
    expect((system as { kind?: string } | undefined)?.kind).toBe('postgres');
  });

  it('calling onProjectLoaded twice rebuilds the visitor with the new system id', () => {
    const plugin = new PrismaPlugin();
    plugin.onProjectLoaded({ rootDir: fixturePath('postgres-basic'), packageJson: null, files: [] });
    const visitor1 = plugin.visitor;
    plugin.onProjectLoaded({ rootDir: fixturePath('mongodb-basic'), packageJson: null, files: [] });
    const visitor2 = plugin.visitor;
    expect(visitor1).not.toBe(visitor2);
  });

  // #364 — `prismaSchemaFolder` + orchestrator preDiscovery. The
  // alphabetically-first canonical schema lives under
  // `prisma/models/` (a model-only shard); the datasource file
  // `schema.prisma` lives one level up. Pre-#364, the plugin
  // narrowed extraction to `dirname(preDiscovered[0])` =
  // `prisma/models/` — which has no datasource — and the two-pass
  // parser returned an empty batch. Post-fix uses the COMMON
  // ANCESTOR of all preDiscovered paths (`prisma/`) so the
  // recursive walk picks up both the shards and the datasource.
  it('#364 — common-ancestor dir lets the schema-folder datasource be discovered', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-schemafolder-prediscover-'));
    try {
      // Layout:
      //   prisma/schema.prisma           ← datasource (alphabetically last)
      //   prisma/models/billing.prisma   ← model-only (alphabetically first)
      //   prisma/models/event.prisma     ← model-only
      await fs.mkdir(path.join(tmp, 'prisma/models'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'prisma/schema.prisma'),
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
          'generator client {',
          '  provider        = "prisma-client-js"',
          '  previewFeatures = ["prismaSchemaFolder"]',
          '}',
          '',
        ].join('\n'),
      );
      await fs.writeFile(
        path.join(tmp, 'prisma/models/billing.prisma'),
        [
          'model Billing {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );
      await fs.writeFile(
        path.join(tmp, 'prisma/models/event.prisma'),
        [
          'model Event {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );
      // The orchestrator's findCanonicalPrismaSchemas returns
      // paths in sorted order; the first entry is a model shard.
      const preDiscovered = [
        path.join(tmp, 'prisma/models/billing.prisma'),
        path.join(tmp, 'prisma/models/event.prisma'),
        path.join(tmp, 'prisma/schema.prisma'),
      ];

      // Consumer sub-repo has no local schema at all.
      const consumer = path.join(tmp, 'apps/web');
      await fs.mkdir(consumer, { recursive: true });

      const plugin = new PrismaPlugin();
      const batch = plugin.onProjectLoaded({
        rootDir: consumer,
        packageJson: null,
        files: [],
        frameworkDiscoveries: { [PRISMA_PLUGIN_ID]: preDiscovered },
      });
      const system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
      const tables = batch.nodes.filter((n) => n.nodeType === 'DatabaseTable');
      // Both the datasource AND both model shards must be picked up.
      expect(system).toBeDefined();
      expect((system as { kind?: string }).kind).toBe('postgres');
      expect(tables.map((t) => (t as { name: string }).name).sort()).toEqual(['Billing', 'Event']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // #364 — single-path case: parity with the prior `dirname(...)`
  // behavior. A monorepo with one schema file shouldn't change.
  it('#364 — single-path preDiscovered uses that path\'s dirname (no regression)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-single-prediscover-'));
    try {
      await fs.mkdir(path.join(tmp, 'prisma'), { recursive: true });
      const schemaPath = path.join(tmp, 'prisma/schema.prisma');
      await fs.writeFile(
        schemaPath,
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
          'model User {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );
      const consumer = path.join(tmp, 'apps/web');
      await fs.mkdir(consumer, { recursive: true });

      const plugin = new PrismaPlugin();
      const batch = plugin.onProjectLoaded({
        rootDir: consumer,
        packageJson: null,
        files: [],
        frameworkDiscoveries: { [PRISMA_PLUGIN_ID]: [schemaPath] },
      });
      const system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
      expect(system).toBeDefined();
      expect(batch.nodes.some((n) => n.nodeType === 'DatabaseTable')).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases — module-top-level, await, dedup, $transaction, truncation
// ──────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    batch = await extract('client-usage', 'src/edgecases.ts');
  });

  it('silently skips module-top-level call sites (no enclosing function)', () => {
    // `void prisma.user.findMany()` at module scope has no enclosing
    // function to attribute to. Must NOT appear in the batch at all.
    const performed = edgesOfType(batch, 'PERFORMED_BY') as PerformedByEdge[];
    for (const edge of performed) {
      // Every PERFORMED_BY edge must point at a function we emitted.
      const fn = batch.nodes.find((n) => n.id === edge.to);
      expect(fn).toBeDefined();
    }
    // Specifically: the number of read interactions here must equal
    // the number of functions that actually contain a prisma.user.findMany()
    // in the source (awaited + duplicateWithinFunction + distinctFunction).
    // The top-level call does NOT count.
    const interactions = batch.nodes.filter(
      (n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction'
    );
    // At least 3 distinct per-function interactions for user.findMany.
    // Plus at least 1 raw (longRawQuery). Pin the lower bound.
    expect(interactions.length).toBeGreaterThanOrEqual(4);
  });

  it('detects calls wrapped in await', () => {
    // `await prisma.user.findMany()` must still be detected. The
    // `awaited` function is one of several reads in the fixture.
    const reads = interactionsByOperation(batch, 'read');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('two identical calls in the same function share ONE interaction id (content-addressed on (fn, op, table))', () => {
    // `duplicateWithinFunction` calls `prisma.user.findMany()` twice.
    // The interaction id is keyed on (callSiteFunctionId, operation,
    // targetTableId), so both calls produce the SAME id. The batch is
    // append-only (dedup happens at commit time in the store), so it
    // will contain two physical DatabaseInteraction entries that share
    // the same id — assert the uniqueness at the id level.
    const userReads = interactionsByOperation(batch, 'read').filter((i) => i.orm === 'prisma');
    const allIds = userReads.map((i) => i.id);
    const uniqueIds = new Set(allIds);
    // At least one id appears more than once (the duplicate within one fn).
    expect(allIds.length).toBeGreaterThan(uniqueIds.size);
  });

  it('two calls in DIFFERENT functions produce DISTINCT interactions', () => {
    // Same operation on the same table from two functions must yield
    // two distinct interaction ids (differing callSiteFunctionId).
    const reads = interactionsByOperation(batch, 'read').filter(
      (i) => i.orm === 'prisma'
    );
    const ids = new Set(reads.map((r) => r.id));
    // At least two distinct interaction ids for user.findMany (awaited,
    // duplicateWithinFunction, distinctFunction → 3 distinct callers).
    expect(ids.size).toBeGreaterThanOrEqual(3);
  });

  it('DOES detect calls on a $transaction tx receiver (#388)', () => {
    // `tx.user.findMany()` inside `prisma.$transaction(async (tx) => ...)`
    // is recognised: the callback parameter `tx` is bound to the same
    // PrismaClient as the outer receiver. classifyPrismaReceiver walks
    // up from the parameter declaration to the `.$transaction` call
    // and recurses on its receiver.
    const reads = interactionsByOperation(batch, 'read');
    // Expected breakdown (post-#388):
    //   awaited                 → 1 read
    //   duplicateWithinFunction → 2 physical reads (same id, batch is append-only)
    //   distinctFunction        → 1 read
    //   inTransaction (tx.*)    → 1 read (now detected)
    //   longRawQuery            → 0 reads (counted as raw)
    //   module-top-level        → 0 (no enclosing function)
    // Total = 5.
    expect(reads.length).toBe(5);
  });

  it('emits direct-confidence for the $transaction callback DBI (#388)', () => {
    // The tx-bound `tx.user.findMany()` must come through at
    // direct confidence — same proof basis as `prisma.user.findMany()`
    // because the resolver recursed on the outer receiver, which
    // resolves to `new PrismaClient()`.
    const reads = interactionsByOperation(batch, 'read');
    // 5 total reads (see breakdown above). The tx one is the read
    // coming from the inTransaction function. Find it by its enclosing
    // function name via the PERFORMED_BY edge.
    const performed = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY') as PerformedByEdge[];
    const fnNodes = batch.nodes.filter((n) => n.nodeType === 'FunctionDefinition');
    const inTxFn = fnNodes.find((n) => (n as { name: string }).name === 'inTransaction');
    expect(inTxFn).toBeDefined();
    const txReadIds = performed.filter((e) => e.to === inTxFn!.id).map((e) => e.from);
    const txReads = reads.filter((r) => txReadIds.includes(r.id));
    expect(txReads.length).toBeGreaterThanOrEqual(1);
    expect(txReads.every((r) => r.confidence === 'direct')).toBe(true);
  });

  it('truncates rawQuery longer than 500 characters to 500 with a trailing ellipsis', () => {
    const raws = interactionsByOperation(batch, 'raw');
    expect(raws.length).toBe(1);
    const rawQuery = raws[0].rawQuery!;
    expect(rawQuery.length).toBe(500);
    expect(rawQuery.endsWith('…')).toBe(true);
  });

  it('visitor identity is stable between two onProjectLoaded calls', () => {
    // Multiple reads of `plugin.visitor` without an onProjectLoaded call
    // must return the SAME object (cached in _visitor).
    const plugin = new PrismaPlugin();
    plugin.onProjectLoaded({
      rootDir: fixturePath('client-usage'),
      packageJson: null,
      files: [],
    });
    const a = plugin.visitor;
    const b = plugin.visitor;
    expect(a).toBe(b);
  });
});

// ──────────────────────────────────────────────────────────────────────
// onProjectLoaded lifecycle — no-schema project and error propagation
// ──────────────────────────────────────────────────────────────────────

describe('onProjectLoaded lifecycle', () => {
  it('returns an empty batch for a project with no schema.prisma, leaves visitor as no-op', async () => {
    const plugin = new PrismaPlugin();
    // client-usage has a schema — use a different root with no .prisma.
    // The lang-ts package itself has no schema.prisma; use its fixture dir.
    const noSchemaDir = path.resolve(__dirname, '../../../../packages/plugin-api');
    const batch = plugin.onProjectLoaded({
      rootDir: noSchemaDir,
      packageJson: null,
      files: [],
    });
    expect(batch.nodes.filter((n) => n.nodeType === 'DatabaseSystem')).toEqual([]);
    // Visitor stays no-op: extracting any file should produce zero
    // DatabaseInteraction nodes even if the source contains prisma calls.
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const handle = await ts.loadProject({ rootDir: fixturePath('client-usage') });
    const fileBatch = await ts.extractFile(handle, 'src/handlers.ts');
    expect(
      fileBatch.nodes.filter((n) => n.nodeType === 'DatabaseInteraction')
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: commit schema + calls to the canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end: schema + call sites round-trip through the canonical store', () => {
  it('schema batch + file batches commit cleanly and every edge resolves to a real table', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new PrismaPlugin();
      const schemaBatch = plugin.onProjectLoaded({
        rootDir: fixturePath('client-usage'),
        packageJson: null,
        files: [],
      });
      store.commit(schemaBatch, makeBatchMeta(plugin.id));

      const ts = new TsLanguagePlugin();
      ts.registerVisitor(plugin.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('client-usage') });

      for (const file of ['src/handlers.ts', 'src/aliases.ts']) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      // Every WRITES edge's `to` must resolve to a real DatabaseTable.
      const writes = store.findEdges(null, null, 'WRITES') as WritesEdge[];
      expect(writes.length).toBeGreaterThan(0);
      for (const edge of writes) {
        const table = store.getNode('DatabaseTable', edge.to);
        expect(table).not.toBeNull();
      }

      // Every READS edge's `to` must resolve to a real DatabaseTable.
      const reads = store.findEdges(null, null, 'READS') as ReadsEdge[];
      for (const edge of reads) {
        const table = store.getNode('DatabaseTable', edge.to);
        expect(table).not.toBeNull();
      }

      // Every PERFORMED_BY edge's `to` must resolve to a real FunctionDefinition.
      const performed = store.findEdges(null, null, 'PERFORMED_BY') as PerformedByEdge[];
      expect(performed.length).toBeGreaterThan(0);
      for (const edge of performed) {
        const fn = store.getNode('FunctionDefinition', edge.to);
        expect(fn).not.toBeNull();
      }
    } finally {
      store.close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Confidence-decision span events (the hard rule from #67)
// ──────────────────────────────────────────────────────────────────────

describe('confidence decision span events', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(async () => {
    await resetObservability();
    exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    initObservability({ provider });
  });

  afterEach(async () => {
    await resetObservability();
  });

  it('non-canonical AST-resolved receivers and raw queries record a ConfidenceDecision span event', async () => {
    const plugin = new PrismaPlugin();
    plugin.onProjectLoaded({
      rootDir: fixturePath('client-usage'),
      packageJson: null,
      files: [],
    });
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const handle = await ts.loadProject({ rootDir: fixturePath('client-usage') });

    // Aliases fixture contains non-canonical receivers like
    // `database` and `orm` — AST resolution catches them and
    // records a ConfidenceDecision event for telemetry.
    await ts.extractFile(handle, 'src/aliases.ts');
    // handlers.ts contains a raw query — also a confidence decision
    // (dynamic, because we cannot statically resolve the table).
    await ts.extractFile(handle, 'src/handlers.ts');

    const spans = exporter.getFinishedSpans();
    const allEvents = spans.flatMap((s) => s.events);
    const decisions = allEvents.filter((e) => e.name === 'ConfidenceDecision');
    expect(decisions.length).toBeGreaterThan(0);

    // Either the AST-resolution path or the raw path (or both) must appear.
    const hasAstResolved = decisions.some((e) =>
      String(e.attributes?.reason ?? '').includes('AST resolution'),
    );
    const hasRaw = decisions.some((e) => String(e.attributes?.reason ?? '').includes('raw'));
    expect(hasAstResolved || hasRaw).toBe(true);
  });

  // #322 — notable resolver paths emit a ConfidenceDecision tagged
  // by path name (hof-wrapper, free-fn-factory, type-annotation).
  // Lets us measure real-world hit-rate per path in observability.
  it('emits resolver-path ConfidenceDecision for HOF wrappers (#322)', async () => {
    const plugin = new PrismaPlugin();
    plugin.onProjectLoaded({
      rootDir: fixturePath('client-usage'),
      packageJson: null,
      files: [],
    });
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const handle = await ts.loadProject({ rootDir: fixturePath('client-usage') });

    // aliases.ts has `listViaRemember`, `listViaMemoize`,
    // `listViaBlockBody` — all go through the HOF unwrap.
    await ts.extractFile(handle, 'src/aliases.ts');

    const spans = exporter.getFinishedSpans();
    const decisions = spans
      .flatMap((s) => s.events)
      .filter((e) => e.name === 'ConfidenceDecision');

    const hofEvents = decisions.filter((e) =>
      String(e.attributes?.reason ?? '').includes('hof-wrapper'),
    );
    expect(hofEvents.length).toBeGreaterThanOrEqual(1);
    for (const ev of hofEvents) {
      expect(ev.attributes?.['prisma.resolverPath']).toBe('hof-wrapper');
    }
  });

  it('emits resolver-path ConfidenceDecision for type-annotation walks (#322)', async () => {
    const plugin = new PrismaPlugin();
    plugin.onProjectLoaded({
      rootDir: fixturePath('client-usage'),
      packageJson: null,
      files: [],
    });
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const handle = await ts.loadProject({ rootDir: fixturePath('client-usage') });

    // nestjs-di.ts exercises the type-annotation walk (DI'd PrismaService).
    await ts.extractFile(handle, 'src/nestjs-di.ts');

    const spans = exporter.getFinishedSpans();
    const decisions = spans
      .flatMap((s) => s.events)
      .filter((e) => e.name === 'ConfidenceDecision');

    const typeAnnEvents = decisions.filter((e) =>
      String(e.attributes?.reason ?? '').includes('type-annotation'),
    );
    expect(typeAnnEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #349 — Combined integration fixture
//
// Exercises three resolver paths in a single analysis run:
//   1. Cross-package activation (#334)
//   2. NestJS DI receiver via type annotation (#326)
//   3. HOF wrapper resolution (#317)
//
// Each path has its own unit tests; this fixture pins that they all
// stay working when running TOGETHER on a workspace-layout repo
// (`packages/db/` + `apps/api/` separated by a workspace marker).
// ──────────────────────────────────────────────────────────────────────

describe('#349 — combined fixture: cross-package + DI + HOF', () => {
  const fixtureRoot = fixturePath('combined-paths');
  const appsApi = path.join(fixtureRoot, 'apps', 'api');
  const dbSchemaPath = path.join(
    fixtureRoot,
    'packages',
    'db',
    'prisma',
    'schema.prisma',
  );

  it('activates via cross-package workspaceRoot (apps/api has no local schema)', () => {
    const plugin = new PrismaPlugin();
    const applies = plugin.appliesTo({
      rootDir: appsApi,
      workspaceRoot: fixtureRoot,
      packageJson: null,
      files: [],
    });
    expect(applies).toBe(true);
  });

  it('activates via orchestrator-supplied frameworkDiscoveries (#344 integration)', () => {
    const plugin = new PrismaPlugin();
    const applies = plugin.appliesTo({
      rootDir: appsApi,
      // Simulate the orchestrator: it pre-discovered the workspace
      // schema and passes the absolute path through. The plugin
      // should activate from that alone, without re-scanning.
      packageJson: null,
      files: [],
      frameworkDiscoveries: { [PRISMA_PLUGIN_ID]: [dbSchemaPath] },
    });
    expect(applies).toBe(true);
  });

  it('onProjectLoaded adopts the workspace schema and detects DI + HOF call sites', async () => {
    const plugin = new PrismaPlugin();
    plugin.onProjectLoaded({
      rootDir: appsApi,
      workspaceRoot: fixtureRoot,
      packageJson: null,
      files: [],
    });

    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const handle = await ts.loadProject({ rootDir: appsApi });
    const batch = await ts.extractFile(handle, 'src/handlers.ts');

    const reads = interactionsByOperation(batch, 'read').filter(
      (r) => r.confidence === 'direct',
    );
    const writes = interactionsByOperation(batch, 'write').filter(
      (w) => w.confidence === 'direct',
    );

    // Exact counts. The handler file has exactly 2 direct-confidence
    // reads (UserController.list, listAll) and 2 writes
    // (UserController.create, createPost). Using `>= 2` would let a
    // single-path regression slip through if the surviving path
    // somehow doubled — exact counts pin both paths working AND
    // produce a clear regression signal if either drops out.
    expect(reads).toHaveLength(2);
    expect(writes).toHaveLength(2);

    const writesEdges = edgesOfType(batch, 'WRITES') as WritesEdge[];
    const readsEdges = edgesOfType(batch, 'READS') as ReadsEdge[];

    // Asymmetric write targets prove each path independently:
    //   - DI path uniquely emits a User-write
    //     (UserController.create → prisma.user.create)
    //   - HOF path uniquely emits a Post-write
    //     (createPost → cachedPrisma.post.create)
    // If either path regressed to `unresolved`, exactly one of
    // these tables would be missing.
    const userWriteHit = writesEdges.some((e) => e.to === userTableId());
    const postWriteHit = writesEdges.some((e) => e.to === postTableId());
    expect(userWriteHit).toBe(true); // DI path
    expect(postWriteHit).toBe(true); // HOF path

    // Both User-reads must land (one from DI, one from HOF).
    const userReadHits = readsEdges.filter((e) => e.to === userTableId()).length;
    expect(userReadHits).toBe(2);

    // Per-function attribution: every interaction must be attributed
    // to its enclosing function via PERFORMED_BY. Four distinct
    // functions in this file produce DBIs — the 4 interactions
    // therefore land on 4 distinct PERFORMED_BY targets, proving the
    // call sites came from genuinely separate functions (not one
    // function double-counted).
    const performed = edgesOfType(batch, 'PERFORMED_BY') as PerformedByEdge[];
    const performingFns = new Set(performed.map((e) => e.to));
    expect(performingFns.size).toBe(4);
  });

  it('onProjectLoaded via orchestrator discovery yields the same systemId as the workspaceRoot scan', () => {
    const pluginWorkspace = new PrismaPlugin();
    const batchWorkspace = pluginWorkspace.onProjectLoaded({
      rootDir: appsApi,
      workspaceRoot: fixtureRoot,
      packageJson: null,
      files: [],
    });

    const pluginOrchestrated = new PrismaPlugin();
    const batchOrchestrated = pluginOrchestrated.onProjectLoaded({
      rootDir: appsApi,
      packageJson: null,
      files: [],
      frameworkDiscoveries: { [PRISMA_PLUGIN_ID]: [dbSchemaPath] },
    });

    const sysA = batchWorkspace.nodes.find((n) => n.nodeType === 'DatabaseSystem');
    const sysB = batchOrchestrated.nodes.find((n) => n.nodeType === 'DatabaseSystem');
    expect(sysA).toBeDefined();
    expect(sysB).toBeDefined();
    // Content-addressed id — both paths must arrive at the same
    // DatabaseSystem so downstream call-site attribution is
    // identical regardless of which discovery path was used.
    expect(sysA!.id).toBe(sysB!.id);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #147 — Multi-schema workspace first-pick agreement
//
// When a workspace contains MULTIPLE canonical Prisma schemas (rare
// but legal — Prisma 5+ even has `prismaSchemaFolder` preview), the
// per-repo plugin must pick the SAME schema regardless of whether
// discovery happened via the orchestrator (`findCanonicalPrismaSchemas`)
// or the workspaceRoot fallback (`findPrismaSchemaUnder`). Otherwise
// downstream call-site attribution depends on which path fired.
//
// Both functions deterministically pick the first schema in sorted
// order (alphabetical by directory entry name). The fixture has two
// schemas with DIFFERENT datasource names (`alpha`, `beta`) — same
// `kind` (`postgres`), so the systemIds differ only by name — making
// it observable which schema was chosen.
// ──────────────────────────────────────────────────────────────────────

describe('#147 — multi-schema workspace first-pick agreement', () => {
  const fixtureRoot = fixturePath('multi-schema-workspace');
  const consumer = path.join(fixtureRoot, 'apps', 'consumer');
  const schemaA = path.join(fixtureRoot, 'packages', 'a', 'prisma', 'schema.prisma');
  const schemaB = path.join(fixtureRoot, 'packages', 'b', 'prisma', 'schema.prisma');
  const alphaSystemId = idFor.databaseSystem({ kind: 'postgres', name: 'alpha' });
  const betaSystemId = idFor.databaseSystem({ kind: 'postgres', name: 'beta' });

  it('workspaceRoot fallback picks the alphabetically-first schema (alpha, not beta)', () => {
    const plugin = new PrismaPlugin();
    const batch = plugin.onProjectLoaded({
      rootDir: consumer,
      workspaceRoot: fixtureRoot,
      packageJson: null,
      files: [],
    });
    const system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
    expect(system?.id).toBe(alphaSystemId);
    expect(system?.id).not.toBe(betaSystemId);
  });

  it('orchestrator path with sorted list picks the same first schema (alpha)', () => {
    const plugin = new PrismaPlugin();
    // Orchestrator's `findCanonicalPrismaSchemas` sorts. Simulate
    // that here — schemaA comes first because `packages/a/...`
    // sorts before `packages/b/...`.
    const batch = plugin.onProjectLoaded({
      rootDir: consumer,
      packageJson: null,
      files: [],
      frameworkDiscoveries: {
        [PRISMA_PLUGIN_ID]: [schemaA, schemaB],
      },
    });
    const system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
    expect(system?.id).toBe(alphaSystemId);
  });

  it('both discovery paths pick the SAME schema in a multi-schema workspace', () => {
    const pluginWorkspace = new PrismaPlugin();
    const batchWorkspace = pluginWorkspace.onProjectLoaded({
      rootDir: consumer,
      workspaceRoot: fixtureRoot,
      packageJson: null,
      files: [],
    });

    const pluginOrchestrated = new PrismaPlugin();
    const batchOrchestrated = pluginOrchestrated.onProjectLoaded({
      rootDir: consumer,
      packageJson: null,
      files: [],
      frameworkDiscoveries: {
        [PRISMA_PLUGIN_ID]: [schemaA, schemaB],
      },
    });

    const sysWs = batchWorkspace.nodes.find((n) => n.nodeType === 'DatabaseSystem');
    const sysOrch = batchOrchestrated.nodes.find((n) => n.nodeType === 'DatabaseSystem');
    expect(sysWs).toBeDefined();
    expect(sysOrch).toBeDefined();
    // Non-trivial agreement — with two distinct DatabaseSystems
    // in the workspace, this asserts ORDERING agreement, not
    // tautological "they both picked the only schema".
    expect(sysWs!.id).toBe(sysOrch!.id);
    expect(sysWs!.id).toBe(alphaSystemId);
  });
});
