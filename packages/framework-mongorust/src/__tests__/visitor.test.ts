import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { MongorustPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/mongorust/basic');

async function extract(file: string): Promise<NodeBatch> {
  const mongorust = new MongorustPlugin();
  const rust = new RustLanguagePlugin();
  mongorust.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'mongorust-fixture',
    files: ['src/main.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(mongorust.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-mongorust visitor', () => {
  it('emits one DatabaseInteraction per collection-method call', async () => {
    const batch = await extract('src/main.rs');
    // 11 users.<verb> functions (get/list/create/create_many/update/
    //   update_many/replace/delete/delete_all/aggregate/count) = 11
    // 2 orders functions (find_and_update + list) = 2
    // no_turbofish: products.find_one = 1
    // inline_collection: inline.find_one = 1
    // Repo.recent: self.events.find = 1
    // PlainStruct.find: not emitted
    expect(interactions(batch).length).toBe(16);
  });

  it('synthesizes DatabaseTable per collection (kind=collection)', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name).sort();
    expect(names).toEqual(['events', 'inline', 'orders', 'products', 'users']);
    for (const t of tables(batch)) expect(t.kind).toBe('collection');
  });

  it('every interaction carries orm="mongorust" and confidence="direct"', async () => {
    const batch = await extract('src/main.rs');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('mongorust');
      expect(i.confidence).toBe('direct');
    }
  });

  it('detects inline `db.collection::<T>("name").find_one(...)` form', async () => {
    const batch = await extract('src/main.rs');
    const inline = tables(batch).find((t) => t.name === 'inline');
    expect(inline).toBeTruthy();
  });

  it('detects let-binding `let products = db.collection::<T>("products")`', async () => {
    const batch = await extract('src/main.rs');
    const products = tables(batch).find((t) => t.name === 'products');
    expect(products).toBeTruthy();
    const productReads = batch.edges.filter(
      (e) => e.edgeType === 'READS' && e.to === products!.id,
    );
    expect(productReads.length).toBeGreaterThan(0);
  });

  it('detects self.<coll> binding pattern inside an impl method', async () => {
    const batch = await extract('src/main.rs');
    const events = tables(batch).find((t) => t.name === 'events');
    expect(events).toBeTruthy();
  });

  it('does NOT emit for non-mongo `PlainStruct.find(...)`', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name);
    expect(names).not.toContain('s');
    expect(names).not.toContain('not a mongo call');
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('src/main.rs');
    const perfEdges = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perfEdges.length).toBe(interactions(batch).length);
  });
});
