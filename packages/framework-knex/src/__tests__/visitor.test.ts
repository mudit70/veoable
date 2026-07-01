import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { idFor, type DatabaseInteraction, type DatabaseTable } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { KnexPlugin } from '../knex-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/knex');
const fixturePath = (s: string) => path.join(FIXTURE_ROOT, s);

const SYSTEM_ID = idFor.databaseSystem({ kind: 'postgres', name: 'knex' });
const tableId = (name: string): string =>
  idFor.databaseTable({ systemId: SYSTEM_ID, schema: null, name });

async function extractAll(scenario: string, files: string[]): Promise<NodeBatch[]> {
  const plugin = new KnexPlugin();
  plugin.onProjectLoaded({ rootDir: fixturePath(scenario), packageJson: null, files: [] });
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  const batches: NodeBatch[] = [];
  for (const f of files) batches.push(await ts.extractFile(handle, f));
  return batches;
}

function tables(b: NodeBatch): DatabaseTable[] {
  return b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');
}
function dbis(b: NodeBatch): DatabaseInteraction[] {
  return b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
}

describe('Knex (#369)', () => {
  let batch: NodeBatch;
  beforeAll(async () => {
    const batches = await extractAll('basic', ['src/queries.ts']);
    batch = batches[0];
  });

  it('synthesises a DatabaseTable for every observed knex(<name>) string', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('users')).toBe(true);
    expect(names.has('orders')).toBe(true);
    expect(names.has('posts')).toBe(true);
  });

  it('emits direct reads for knex(table).select() / .first() / .count()', () => {
    const reads = dbis(batch).filter((d) => d.operation === 'read');
    const direct = reads.filter((d) => d.confidence === 'direct');
    // listUsers (.select), findUser (.first), countPosts (.count) = 3.
    expect(direct.length).toBeGreaterThanOrEqual(3);
  });

  it('emits a direct write for knex(table).insert(...)', () => {
    const writes = dbis(batch).filter((d) => d.operation === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes.every((d) => d.confidence === 'direct')).toBe(true);
  });

  it('emits a direct update for knex(table).update(...)', () => {
    const updates = dbis(batch).filter((d) => d.operation === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a direct delete for knex(table).del()', () => {
    const deletes = dbis(batch).filter((d) => d.operation === 'delete');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a dynamic raw interaction for knex.raw(...)', () => {
    const raws = dbis(batch).filter((d) => d.operation === 'raw');
    expect(raws.length).toBeGreaterThanOrEqual(1);
    expect(raws.every((d) => d.confidence === 'dynamic')).toBe(true);
  });

  it('routes the call sites to the table id synthesised from the string arg', () => {
    const usersId = tableId('users');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    expect(reads.some((e) => e.to === usersId)).toBe(true);
    expect(writes.some((e) => e.to === usersId)).toBe(true);
  });
});

describe('Knex const-propagation (#386)', () => {
  let batch: NodeBatch;
  beforeAll(async () => {
    const batches = await extractAll('const-table-name', ['src/queries.ts']);
    batch = batches[0];
  });

  it('synthesises tables from identifier-imported consts (`knex(USERS_TABLE)`)', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('users')).toBe(true);
  });

  it('synthesises tables from local const aliases (`const T = POSTS_TABLE; knex(T)`)', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('posts')).toBe(true);
  });

  it('synthesises tables from object property access (`knex(Tables.ORDERS)`)', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('orders')).toBe(true);
  });

  it('continues to handle direct string-literal args', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('sessions')).toBe(true);
  });

  it('does NOT synthesise a table for unresolvable args (function parameter)', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('tableName')).toBe(false);
  });

  it('promotes const-folded reads to direct confidence', () => {
    const reads = dbis(batch).filter((d) => d.operation === 'read');
    const direct = reads.filter((d) => d.confidence === 'direct');
    // listUsers + findPost (chain: where().first) + listOrders + listSessions = 4
    expect(direct.length).toBeGreaterThanOrEqual(4);
  });
});

describe('KnexPlugin.appliesTo', () => {
  it('activates on `knex` dep', () => {
    const plugin = new KnexPlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: { dependencies: { knex: '^3.0.0' } }, files: [] })).toBe(true);
  });
  it('does not activate without knex', () => {
    const plugin = new KnexPlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: { dependencies: { express: '^4.0.0' } }, files: [] })).toBe(false);
  });
});
