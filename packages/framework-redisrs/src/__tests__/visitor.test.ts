import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { RedisrsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/redisrs/basic');

async function extract(file: string): Promise<NodeBatch> {
  const redisrs = new RedisrsPlugin();
  const rust = new RustLanguagePlugin();
  redisrs.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'redisrs-fixture',
    files: ['src/main.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(redisrs.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-redisrs visitor', () => {
  it('emits one DatabaseInteraction per Redis verb call', async () => {
    const batch = await extract('src/main.rs');
    // 18 verbs: get, set, keys, incr, decr, hset, hgetall, sadd,
    //   srem, zadd, zrange, lpush, rpush, lpop, expire, del,
    //   publish, dynamic_key.get, fetch.get = 19
    // PlainStruct.get: not emitted (receiver heuristic rejects 's')
    expect(interactions(batch).length).toBe(19);
  });

  it('synthesizes DatabaseTable per Redis key', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('user:*');
    expect(names).toContain('counter:requests');
    expect(names).toContain('active_users');
    expect(names).toContain('leaderboard');
    expect(names).toContain('queue:jobs');
  });

  it('every interaction carries orm="redisrs"', async () => {
    const batch = await extract('src/main.rs');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('redisrs');
      expect(i.confidence).toBe('direct');
    }
  });

  it('extracts format! prefix as `<prefix>*`', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('user:*');
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('src/main.rs');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);  // sadd/zadd/lpush/rpush
    expect(kinds.has('update')).toBe(true);  // set/incr/decr/hset/expire/publish
    expect(kinds.has('delete')).toBe(true);  // srem/lpop/del
  });

  it('emits READS for read verbs (get/hgetall/zrange)', async () => {
    const batch = await extract('src/main.rs');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('handles self.conn.<verb> inside an impl method', async () => {
    const batch = await extract('src/main.rs');
    const fetch = interactions(batch).find((i) =>
      i.evidence?.snippet?.includes('self.conn.get'),
    );
    expect(fetch).toBeTruthy();
  });

  it('rejects `PlainStruct.get(literal)` on a non-Redis receiver', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name);
    expect(names).not.toContain('not_a_redis_key');
  });

  it('uses per-call-site placeholder for dynamic keys (no bucketing)', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name);
    expect(names).not.toContain('<dynamic>');
    const dynamicTables = names.filter((n) => n.startsWith('<dynamic:'));
    expect(new Set(dynamicTables).size).toBeGreaterThanOrEqual(2);
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('src/main.rs');
    const perfEdges = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perfEdges.length).toBe(interactions(batch).length);
  });
});
