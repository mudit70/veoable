import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { IoredisPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/ioredis/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new IoredisPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-ioredis visitor', () => {
  it('emits one DatabaseInteraction per Redis verb call', async () => {
    const batch = await extract('cache.ts');
    // getUser, setUser, incrCounter, decrCounter, listKeys,
    // hashSet, hashGetAll, setAdd, setRemove, zsetAdd, zsetRange,
    // listPush, listPop, expireKey, deleteKey, publishEvent,
    // dynamicKey = 17
    expect(interactions(batch).length).toBe(17);
  });

  it('synthesizes DatabaseTable per Redis key', async () => {
    const batch = await extract('cache.ts');
    const names = tables(batch).map((t) => t.name);
    // `user:${id}` → `user:*` (literal prefix only)
    expect(names).toContain('user:*');
    expect(names).toContain('counter:requests');
    expect(names).toContain('counter:errors');
    expect(names).toContain('active_users');
    expect(names).toContain('leaderboard');
    expect(names).toContain('queue:jobs');
    expect(names).toContain('profile');
  });

  it('every interaction carries orm="ioredis"', async () => {
    const batch = await extract('cache.ts');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('ioredis');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS for read verbs (get/hgetall/zrange/keys)', async () => {
    const batch = await extract('cache.ts');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('cache.ts');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);   // sadd/zadd/lpush
    expect(kinds.has('update')).toBe(true);   // set/incr/hset/expire/publish
    expect(kinds.has('delete')).toBe(true);   // srem/lpop/del
  });

  it('extracts template-literal prefix as `<prefix>*`', async () => {
    const batch = await extract('cache.ts');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('user:*');
  });

  it('uses per-call-site placeholder for dynamic keys (no bucketing)', async () => {
    const batch = await extract('cache.ts');
    const names = tables(batch).map((t) => t.name);
    expect(names).not.toContain('<dynamic>');
    const dynamicTables = names.filter((n) => n.startsWith('<dynamic:'));
    expect(dynamicTables.length).toBeGreaterThanOrEqual(1);
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('cache.ts');
    const perf = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perf.length).toBe(interactions(batch).length);
  });

  it('rejects all emits in a file with no ioredis/redis import', async () => {
    const batch = await extract('no_imports.ts');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
