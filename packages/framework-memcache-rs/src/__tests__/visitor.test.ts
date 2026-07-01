import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { MemcacheRsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/memcache-rs/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new MemcacheRsPlugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'memcache-rs-fixture',
    files: ['src/main.rs', 'src/no_imports.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(plugin.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-memcache-rs visitor', () => {
  it('emits one DatabaseInteraction per memcache verb', async () => {
    const batch = await extract('src/main.rs');
    // get, set, add, replace, incr, decr, touch, delete, flush = 9
    // dynamic_key skipped
    expect(interactions(batch).length).toBe(9);
  });

  it('synthesizes DatabaseTable per key', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('user:1');
    expect(names).toContain('entry:new');
    expect(names).toContain('entry:existing');
    expect(names).toContain('counter:requests');
    expect(names).toContain('counter:errors');
    expect(names).toContain('session:keepalive');
    expect(names).toContain('session:abc');
    expect(names).toContain('<flush:all>');
  });

  it('every interaction carries orm="memcache-rs"', async () => {
    const batch = await extract('src/main.rs');
    for (const i of interactions(batch)) expect(i.orm).toBe('memcache-rs');
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('src/main.rs');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('delete')).toBe(true);
  });

  it('emits READS for get', async () => {
    const batch = await extract('src/main.rs');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects all emits in a file without memcache crate use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
