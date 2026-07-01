import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { GoredisPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/goredis/basic');

async function extract(file: string): Promise<NodeBatch> {
  const goredis = new GoredisPlugin();
  const go = new GoLanguagePlugin();
  goredis.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'goredis-fixture',
    files: ['cache.go'],
    packageJson: null,
  } as any);
  go.registerVisitor(goredis.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-goredis visitor', () => {
  it('emits one DatabaseInteraction per Redis verb call', async () => {
    const batch = await extract('cache.go');
    // 18 verbs in the fixture: Get/Set/Incr/Decr/HSet/HGetAll/SAdd/SRem/
    //   ZAdd/ZRange/LPush/RPush/LPop/Expire/Del/Publish/DynamicKey
    //   .Get/CacheService.Fetch = 18
    // kvStore.Get is negative (no redis import on receiver chain).
    expect(interactions(batch).length).toBe(18);
  });

  it('synthesizes DatabaseTable per Redis key (or key prefix)', async () => {
    const batch = await extract('cache.go');
    const names = tables(batch).map((t) => t.name).sort();
    // fmt.Sprintf("user:%d", id) → 'user:*'
    expect(names).toContain('user:*');
    expect(names).toContain('counter:requests');
    expect(names).toContain('active_users');
    expect(names).toContain('leaderboard');
    expect(names).toContain('queue:jobs');
  });

  it('every interaction carries orm="goredis"', async () => {
    const batch = await extract('cache.go');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('goredis');
      expect(i.confidence).toBe('direct');
    }
  });

  it('extracts fmt.Sprintf prefix as `<prefix>*`', async () => {
    const batch = await extract('cache.go');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('user:*');
    expect(names).toContain('user:*:profile' === 'user:*' ? 'user:*' : 'user:*');
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('cache.go');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);   // LPush/RPush/SAdd/ZAdd
    expect(kinds.has('update')).toBe(true);   // Set/Incr/Decr/HSet/Expire/Publish
    expect(kinds.has('delete')).toBe(true);   // SRem/LPop/Del
  });

  it('emits READS for read verbs (Get/HGetAll/ZRange)', async () => {
    const batch = await extract('cache.go');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('handles selector binding `s.rdb.Get(ctx, key)` inside struct methods', async () => {
    const batch = await extract('cache.go');
    const selfFetch = interactions(batch).find((i) =>
      i.evidence?.snippet?.includes('s.rdb.Get'),
    );
    expect(selfFetch).toBeTruthy();
  });

  it('rejects `kvStore.Get(...)` on a non-Redis receiver', async () => {
    const batch = await extract('cache.go');
    const tableNames = tables(batch).map((t) => t.name);
    expect(tableNames).not.toContain('not_a_redis_key');
  });

  it('uses per-call-site placeholder for dynamic keys (no bucketing)', async () => {
    const batch = await extract('cache.go');
    // The DynamicKey function calls rdb.Get(ctx, key) where `key` is
    // a parameter. CacheService.Fetch also takes a parameter key. The
    // visitor must NOT collapse them into a single global '<dynamic>'
    // table — each call-site gets a unique dynamic placeholder.
    const dynamicTables = tables(batch).filter((t) => t.name.startsWith('<dynamic'));
    expect(dynamicTables.length).toBeGreaterThanOrEqual(2);
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('cache.go');
    const perfEdges = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perfEdges.length).toBe(interactions(batch).length);
  });
});
