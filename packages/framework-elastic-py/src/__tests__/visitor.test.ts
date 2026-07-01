import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { ElasticPyPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/elastic-py/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new ElasticPyPlugin();
  const py = new PyLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'elastic-py-fixture',
    files: ['search.py', 'no_imports.py'],
    packageJson: null,
  } as any);
  py.registerVisitor(plugin.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-elastic-py visitor', () => {
  it('emits one DatabaseInteraction per ES verb call', async () => {
    const batch = await extract('search.py');
    // index, search, get, delete, update, count, exists = 7
    // dynamic_index skipped
    expect(interactions(batch).length).toBe(7);
  });

  it('synthesizes DatabaseTable per index', async () => {
    const batch = await extract('search.py');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('users');
    expect(names).toContain('orders');
    expect(names).toContain('audit-log');
  });

  it('every interaction carries orm="elastic-py"', async () => {
    const batch = await extract('search.py');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('elastic-py');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits 4 READS (search/get/count/exists)', async () => {
    const batch = await extract('search.py');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBe(4);
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('search.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('delete')).toBe(true);
  });

  it('uses kind="collection" for ES indices', async () => {
    const batch = await extract('search.py');
    for (const t of tables(batch)) {
      expect(t.kind).toBe('collection');
    }
  });

  it('rejects all emits in a file with no elasticsearch import', async () => {
    const batch = await extract('no_imports.py');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
