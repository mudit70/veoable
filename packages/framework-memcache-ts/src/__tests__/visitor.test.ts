import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { MemcacheTsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/memcache-ts/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new MemcacheTsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-memcache-ts visitor', () => {
  it('emits one DatabaseInteraction per memcache verb', async () => {
    const batch = await extract('cache.ts');
    // get, set, increment, decrement, delete, add, replace, touch,
    // dynamicKey = 9
    expect(interactions(batch).length).toBe(9);
  });

  it('synthesizes DatabaseTable per key', async () => {
    const batch = await extract('cache.ts');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('user:*');
    expect(names).toContain('counter:requests');
    expect(names).toContain('counter:errors');
    expect(names).toContain('session:abc');
    expect(names).toContain('entry:new');
    expect(names).toContain('entry:existing');
    expect(names).toContain('session:keep-alive');
  });

  it('every interaction carries orm="memcache-ts"', async () => {
    const batch = await extract('cache.ts');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('memcache-ts');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS for get verb', async () => {
    const batch = await extract('cache.ts');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('cache.ts');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true); // add
    expect(kinds.has('update')).toBe(true); // set/incr/decr/replace/touch
    expect(kinds.has('delete')).toBe(true); // delete
  });

  it('uses per-call-site placeholder for dynamic keys', async () => {
    const batch = await extract('cache.ts');
    const names = tables(batch).map((t) => t.name);
    const dyn = names.filter((n) => n.startsWith('<dynamic:'));
    expect(dyn.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects all emits in a file with no memjs import', async () => {
    const batch = await extract('no_imports.ts');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
