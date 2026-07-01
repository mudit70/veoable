import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  idFor,
  type DatabaseColumn,
  type DatabaseInteraction,
  type DatabaseTable,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { DrizzlePlugin } from '../drizzle-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/drizzle');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

const SYSTEM_ID = idFor.databaseSystem({ kind: 'postgres', name: 'drizzle' });
const tableId = (name: string): string =>
  idFor.databaseTable({ systemId: SYSTEM_ID, schema: null, name });

async function extractAll(scenario: string, files: string[]): Promise<NodeBatch[]> {
  const plugin = new DrizzlePlugin();
  plugin.onProjectLoaded({ rootDir: fixturePath(scenario), packageJson: null, files: [] });
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  const batches: NodeBatch[] = [];
  for (const f of files) batches.push(await ts.extractFile(handle, f));
  return batches;
}

function tables(batch: NodeBatch): DatabaseTable[] {
  return batch.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');
}
function columns(batch: NodeBatch): DatabaseColumn[] {
  return batch.nodes.filter((n): n is DatabaseColumn => n.nodeType === 'DatabaseColumn');
}
function dbis(batch: NodeBatch): DatabaseInteraction[] {
  return batch.nodes.filter(
    (n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction',
  );
}

describe('Drizzle schema discovery (#365)', () => {
  let schemaBatch: NodeBatch;
  beforeAll(async () => {
    const batches = await extractAll('basic', ['src/schema.ts']);
    schemaBatch = batches[0];
  });

  it('emits a DatabaseTable for every pgTable() call', () => {
    const names = tables(schemaBatch).map((t) => t.name).sort();
    expect(names).toEqual(['posts', 'users']);
  });

  it('uses the string arg as the table name (not the variable name)', () => {
    // `usersTable = pgTable('users', ...)` — table name is 'users'.
    expect(tables(schemaBatch).find((t) => t.name === 'users')).toBeDefined();
    expect(tables(schemaBatch).find((t) => t.name === 'usersTable')).toBeUndefined();
  });

  it('emits a DatabaseColumn per shape property', () => {
    const usersId = tableId('users');
    const usersColumns = columns(schemaBatch).filter((c) => c.tableId === usersId);
    const names = usersColumns.map((c) => c.name).sort();
    expect(names).toEqual(['createdAt', 'email', 'id', 'name']);
  });
});

describe('Drizzle receiver detection (#365)', () => {
  let queryBatch: NodeBatch;
  beforeAll(async () => {
    const batches = await extractAll('basic', ['src/schema.ts', 'src/queries.ts']);
    queryBatch = batches[1];
  });

  it('emits a direct-confidence DBI for db.select().from(usersTable)', () => {
    const reads = dbis(queryBatch).filter((d) => d.operation === 'read');
    const direct = reads.filter((d) => d.confidence === 'direct');
    // listUsers + listPosts = 2 read calls.
    expect(direct.length).toBeGreaterThanOrEqual(2);
  });

  it('emits a direct-confidence write for db.insert(usersTable)', () => {
    const writes = dbis(queryBatch).filter((d) => d.operation === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('emits a direct-confidence update for db.update(usersTable).set(...)', () => {
    const updates = dbis(queryBatch).filter((d) => d.operation === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a direct-confidence delete for db.delete(usersTable).where(...)', () => {
    const deletes = dbis(queryBatch).filter((d) => d.operation === 'delete');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a dynamic-confidence raw interaction for db.execute(...)', () => {
    const raws = dbis(queryBatch).filter((d) => d.operation === 'raw');
    expect(raws.length).toBeGreaterThanOrEqual(1);
    expect(raws.every((d) => d.confidence === 'dynamic')).toBe(true);
  });

  it('READS/WRITES edges route to the schema-declared table id', () => {
    const usersId = tableId('users');
    const reads = queryBatch.edges.filter((e) => e.edgeType === 'READS');
    const writes = queryBatch.edges.filter((e) => e.edgeType === 'WRITES');
    expect(reads.some((e) => e.to === usersId)).toBe(true);
    expect(writes.some((e) => e.to === usersId)).toBe(true);
  });
});

describe('Drizzle db.transaction(tx => ...) callback (#387)', () => {
  let batches: NodeBatch[];
  beforeAll(async () => {
    batches = await extractAll('transaction', ['src/schema.ts', 'src/queries.ts']);
  });

  it('detects tx.insert(<table>).values(...) inside transaction callback', () => {
    const writes = batches.flatMap(dbis).filter((d) => d.operation === 'write');
    // createUserAndPost emits 2 inserts, plainInsert emits 1 → total >= 3.
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('detects tx.update(<table>).set(...) inside transaction callback', () => {
    const updates = batches.flatMap(dbis).filter((d) => d.operation === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('detects tx.select().from(<table>) inside transaction callback', () => {
    const reads = batches.flatMap(dbis).filter((d) => d.operation === 'read');
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('routes tx-bound DBIs to the canonical table ids from schema discovery', () => {
    const allEdges = batches.flatMap((b) => b.edges);
    const writeTargets = new Set(
      allEdges.filter((e) => e.edgeType === 'WRITES').map((e) => e.to),
    );
    expect(writeTargets.has(tableId('users'))).toBe(true);
    expect(writeTargets.has(tableId('posts'))).toBe(true);
    // Confirm column extraction from schema also fires.
    const allCols = batches.flatMap(columns);
    expect(allCols.length).toBeGreaterThan(0);
  });
});

describe('Drizzle nested transaction savepoints (#400)', () => {
  let batches: NodeBatch[];
  beforeAll(async () => {
    batches = await extractAll('transaction', ['src/schema.ts', 'src/queries.ts']);
  });

  it('detects tx2.insert(<table>) inside nested tx.transaction(tx2 => ...)', () => {
    const writes = batches.flatMap(dbis).filter((d) => d.operation === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(4);
    expect(writes.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('detects tx2.update(<table>).set(...) inside nested tx.transaction(tx2 => ...)', () => {
    const updates = batches.flatMap(dbis).filter((d) => d.operation === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('routes nested-tx DBIs to canonical table ids', () => {
    const writeTargets = new Set(
      batches.flatMap((b) => b.edges)
        .filter((e) => e.edgeType === 'WRITES')
        .map((e) => e.to),
    );
    expect(writeTargets.has(tableId('users'))).toBe(true);
    expect(writeTargets.has(tableId('posts'))).toBe(true);
  });
});

describe('Drizzle namespace-imported tables (#397)', () => {
  let batches: NodeBatch[];
  beforeAll(async () => {
    batches = await extractAll('namespace-import', ['src/schema.ts', 'src/queries.ts']);
  });

  it('resolves db.insert(schema.users) via lang-ts namespace-import lookup', () => {
    const writes = batches.flatMap(dbis).filter((d) => d.operation === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('resolves db.select().from(schema.posts) via namespace lookup', () => {
    const reads = batches.flatMap(dbis).filter((d) => d.operation === 'read');
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('resolves db.update(schema.auditLog).set(...) via namespace lookup', () => {
    const updates = batches.flatMap(dbis).filter((d) => d.operation === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('routes namespace-bound DBIs to canonical table ids from the producer file', () => {
    const writeTargets = new Set(
      batches.flatMap((b) => b.edges)
        .filter((e) => e.edgeType === 'WRITES')
        .map((e) => e.to),
    );
    expect(writeTargets.has(tableId('users'))).toBe(true);
    expect(writeTargets.has(tableId('audit_log'))).toBe(true);
    expect(writeTargets.has(tableId('auditLog'))).toBe(false);
  });
});

describe('DrizzlePlugin.appliesTo', () => {
  it('activates on `drizzle-orm` dep', () => {
    const plugin = new DrizzlePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { 'drizzle-orm': '^0.30.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('does not activate without drizzle-orm', () => {
    const plugin = new DrizzlePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      }),
    ).toBe(false);
  });
});
