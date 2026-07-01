import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { ElasticRsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/elastic-rs/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new ElasticRsPlugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'elastic-rs-fixture',
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

describe('framework-elastic-rs visitor', () => {
  it('emits one DatabaseInteraction per ES verb with literal index', async () => {
    const batch = await extract('src/main.rs');
    // index, search, get, update, delete = 5
    expect(interactions(batch).length).toBe(5);
  });

  it('extracts index from various Parts variants', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name);
    // Most operations use 'users' (deduped). search uses 'orders'.
    expect(names).toContain('users');
    expect(names).toContain('orders');
  });

  it('every interaction carries orm="elastic-rs"', async () => {
    const batch = await extract('src/main.rs');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('elastic-rs');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS for search/get', async () => {
    const batch = await extract('src/main.rs');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBe(2);
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('src/main.rs');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('delete')).toBe(true);
  });

  it('uses kind="collection" for ES indices', async () => {
    const batch = await extract('src/main.rs');
    for (const t of tables(batch)) expect(t.kind).toBe('collection');
  });

  it('rejects all emits in a file without elasticsearch crate use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
