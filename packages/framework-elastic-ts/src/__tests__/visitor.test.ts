import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { ElasticTsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/elastic-ts/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new ElasticTsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-elastic-ts visitor', () => {
  it('emits one DatabaseInteraction per ES verb call with literal index', async () => {
    const batch = await extract('search.ts');
    // indexUser, searchUsers, getUser, deleteUser, updateUser,
    // countOrders, existsAudit = 7 (dynamicIndex skipped)
    expect(interactions(batch).length).toBe(7);
  });

  it('synthesizes DatabaseTable per literal index', async () => {
    const batch = await extract('search.ts');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('users');
    expect(names).toContain('orders');
    expect(names).toContain('audit-log');
  });

  it('every interaction carries orm="elastic-ts"', async () => {
    const batch = await extract('search.ts');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('elastic-ts');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS for search/get/exists/count', async () => {
    const batch = await extract('search.ts');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBe(4);
  });

  it('emits WRITES with right kinds for index/update/delete', async () => {
    const batch = await extract('search.ts');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true); // indexUser
    expect(kinds.has('update')).toBe(true); // updateUser
    expect(kinds.has('delete')).toBe(true); // deleteUser
  });

  it('emits PERFORMED_BY for each interaction', async () => {
    const batch = await extract('search.ts');
    const perf = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perf.length).toBe(interactions(batch).length);
  });

  it('uses kind="collection" for ES indices', async () => {
    const batch = await extract('search.ts');
    for (const t of tables(batch)) {
      expect(t.kind).toBe('collection');
    }
  });

  it('rejects all emits in a file with no @elastic/elasticsearch import', async () => {
    const batch = await extract('no_imports.ts');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
