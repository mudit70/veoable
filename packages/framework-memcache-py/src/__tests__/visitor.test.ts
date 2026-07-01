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
import { MemcachePyPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/memcache-py/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new MemcachePyPlugin();
  const py = new PyLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'memcache-py-fixture',
    files: ['cache.py', 'no_imports.py'],
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

describe('framework-memcache-py visitor', () => {
  it('emits one DatabaseInteraction per memcache verb', async () => {
    const batch = await extract('cache.py');
    // get_user, set_user, add_entry, replace_entry, incr_counter,
    // decr_counter, delete_session, touch_key, get_many, dynamic_key
    // = 10
    expect(interactions(batch).length).toBe(10);
  });

  it('synthesizes DatabaseTable per key', async () => {
    const batch = await extract('cache.py');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('user:1');
    expect(names).toContain('entry:new');
    expect(names).toContain('entry:existing');
    expect(names).toContain('counter:requests');
    expect(names).toContain('counter:errors');
    expect(names).toContain('session:abc');
    expect(names).toContain('session:keepalive');
  });

  it('every interaction carries orm="memcache-py"', async () => {
    const batch = await extract('cache.py');
    for (const i of interactions(batch)) expect(i.orm).toBe('memcache-py');
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('cache.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('delete')).toBe(true);
  });

  it('emits READS for get/get_many', async () => {
    const batch = await extract('cache.py');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('uses per-call-site placeholder for dynamic keys', async () => {
    const batch = await extract('cache.py');
    const names = tables(batch).map((t) => t.name);
    const dyn = names.filter((n) => n.startsWith('<dynamic:'));
    expect(dyn.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects all emits in a file without pymemcache import', async () => {
    const batch = await extract('no_imports.py');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
