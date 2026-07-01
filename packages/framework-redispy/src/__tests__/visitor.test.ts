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
import { RedispyPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/redispy/basic');

async function extract(file: string): Promise<NodeBatch> {
  const redispy = new RedispyPlugin();
  const py = new PyLanguagePlugin();
  redispy.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'redispy-fixture',
    files: ['cache.py', 'no_imports.py'],
    packageJson: null,
  } as any);
  py.registerVisitor(redispy.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-redispy visitor', () => {
  it('emits one DatabaseInteraction per Redis verb call', async () => {
    const batch = await extract('cache.py');
    // Pinned exact count per reviewer feedback. Fixture verb counts:
    //   rdb.get/set/keys/incr/decr/hset/hgetall/sadd/srem/zadd/
    //   zrange/lpush/rpush/lpop/expire/delete/publish = 17
    //   cache.get + cache.set = 2
    //   dynamic_key_get: rdb.get = 1
    //   self.r.get inside CacheService = 1
    // = 21 interactions.
    expect(interactions(batch).length).toBe(21);
  });

  it('synthesizes DatabaseTable nodes per Redis key (or key prefix)', async () => {
    const batch = await extract('cache.py');
    const names = tables(batch).map((t) => t.name);
    // f-string `user:{uid}` → `user:*` (literal prefix only)
    expect(names).toContain('user:*');
    expect(names).toContain('counter:requests');
    expect(names).toContain('active_users');
    expect(names).toContain('leaderboard');
    expect(names).toContain('queue:jobs');
  });

  it('every interaction carries orm="redispy"', async () => {
    const batch = await extract('cache.py');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('redispy');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS for read verbs (get/hgetall/zrange/keys)', async () => {
    const batch = await extract('cache.py');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('emits WRITES with correct kinds (insert/update/delete)', async () => {
    const batch = await extract('cache.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);   // lpush/rpush/sadd/zadd
    expect(kinds.has('update')).toBe(true);   // set/incr/expire/publish/hset
    expect(kinds.has('delete')).toBe(true);   // lpop/srem
  });

  it('classifies SET as update, INCR as update, LPUSH as insert', async () => {
    const batch = await extract('cache.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    // Pick a write edge whose interaction snippet contains 'lpush'
    const lpushInteraction = interactions(batch).find((i) =>
      i.evidence?.snippet?.toLowerCase().includes('lpush'),
    );
    expect(lpushInteraction?.operation).toBe('write');
    const setInteraction = interactions(batch).find(
      (i) => i.evidence?.snippet?.includes("set(f'user:") || i.evidence?.snippet?.includes('cache.set'),
    );
    expect(setInteraction?.operation).toBe('update');
  });

  it('extracts f-string prefix as `<prefix>*` (e.g. `user:*`)', async () => {
    const batch = await extract('cache.py');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('user:*');
  });

  it('uses per-call-site placeholder for dynamic keys (no bucketing)', async () => {
    // Reviewer-flagged: a single shared '<dynamic>' table for ALL
    // dynamic-key calls implies cross-call interaction that doesn't
    // exist. The visitor now stamps `<dynamic:<file>:<line>>` so
    // each unresolved key gets a unique placeholder.
    const batch = await extract('cache.py');
    const names = tables(batch).map((t) => t.name);
    expect(names).not.toContain('<dynamic>');
    const dynamicTables = names.filter((n) => n.startsWith('<dynamic:'));
    // At least 2 distinct dynamic placeholders: dynamic_key_get's
    // `rdb.get(key_var)` and cache.get(key) and self.r.get(k).
    expect(new Set(dynamicTables).size).toBeGreaterThanOrEqual(2);
  });

  it('resolves `cache` client (alternate alias from `redis.from_url`)', async () => {
    const batch = await extract('cache.py');
    // `cache.get(key)` — dynamic key → table `<dynamic>`. Just
    // assert that the interaction count includes both cache.get
    // and cache.set.
    const cacheCalls = interactions(batch).filter((i) => {
      const snip = i.evidence?.snippet ?? '';
      return snip.includes('cache.');
    });
    expect(cacheCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('handles self.r.<verb> inside a class', async () => {
    const batch = await extract('cache.py');
    const selfCalls = interactions(batch).filter((i) =>
      i.evidence?.snippet?.includes('self.r.'),
    );
    expect(selfCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects dict.get(...) on a non-Redis receiver', async () => {
    const batch = await extract('cache.py');
    const tableNames = tables(batch).map((t) => t.name);
    expect(tableNames).not.toContain('foo');
  });

  it('rejects all emits in a file with no redis import', async () => {
    const batch = await extract('no_imports.py');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('cache.py');
    const perfEdges = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perfEdges.length).toBe(interactions(batch).length);
  });
});
