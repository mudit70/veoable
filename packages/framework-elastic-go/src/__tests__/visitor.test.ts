import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { ElasticGoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/elastic-go/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new ElasticGoPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-elastic-go visitor', () => {
  it('emits one DatabaseInteraction per ES verb with literal index', async () => {
    const batch = await extract('search.go');
    // indexUser, getUser, updateUser, deleteUser, searchOrders,
    // existsAudit = 6 (dynamicIndex skipped)
    expect(interactions(batch).length).toBe(6);
  });

  it('extracts index from positional args and from WithIndex options', async () => {
    const batch = await extract('search.go');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('users');
    expect(names).toContain('orders');
    expect(names).toContain('audit-log');
  });

  it('every interaction carries orm="elastic-go"', async () => {
    const batch = await extract('search.go');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('elastic-go');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS for search/get/exists', async () => {
    const batch = await extract('search.go');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBe(3);
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('search.go');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('delete')).toBe(true);
  });

  it('uses kind="collection" for ES indices', async () => {
    const batch = await extract('search.go');
    for (const t of tables(batch)) expect(t.kind).toBe('collection');
  });

  it('rejects all emits in a file without go-elasticsearch import', async () => {
    const batch = await extract('no_imports.go');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
