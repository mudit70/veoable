import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseInteraction,
  DatabaseTable,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { SeaormPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/seaorm/basic');

async function extract(file: string): Promise<NodeBatch> {
  const seaorm = new SeaormPlugin();
  const rust = new RustLanguagePlugin();
  seaorm.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'seaorm-fixture',
    files: ['src/main.rs', 'src/entities.rs', 'src/handlers.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(seaorm.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-seaorm visitor', () => {
  it('emits one DatabaseInteraction per entity-verb call', async () => {
    const batch = await extract('src/main.rs');
    // read_calls:
    //   User::find, User::find_by_id, User::find_with_related — 3 reads
    // write_calls:
    //   insert, insert_many, update_many, delete_by_id, delete_many — 5 writes
    // rejected_scoped_paths:
    //   User::find inside (top-level emit, the Column::Name is a
    //   different node and doesn't add anything) — 1 read
    // active_model_value_form:
    //   am.insert(db) — 1 write (inferred confidence)
    // active_model_pascal:
    //   user_am.update(db), user_am.delete(db) — 1 update + 1 delete (inferred)
    // = 3 + 5 + 1 + 1 + 2 = 12 interactions.
    expect(interactions(batch).length).toBe(12);
  });

  it('synthesizes a DatabaseTable from the entity name', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name).sort();
    // V1: the scanner picks up the LAST explicit table_name in the
    // file ("orders" here, since both user_entity and order_entity
    // sit at module scope and the last one wins under our 'Entity'
    // map key). All call sites in the file map to that one table
    // until alias-resolution lands as a follow-up.
    expect(names.length).toBeGreaterThan(0);
    // Project scan resolves User → users (via per-file alias chain)
    // OR Order → orders OR snake_case + pluralize fallback. Cross-
    // file may also surface 'products' via handlers.rs.
    const ok =
      names.includes('orders')
      || names.includes('users')
      || names.includes('user')
      || names.includes('products');
    expect(ok).toBe(true);
  });

  it('every interaction carries orm="seaorm"', async () => {
    const batch = await extract('src/main.rs');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('seaorm');
      // Scoped-path emits are 'direct'; ActiveModel value-form
      // emits are 'inferred'.
      expect(['direct', 'inferred']).toContain(i.confidence);
    }
  });

  it('emits READS and WRITES edges per operation', async () => {
    const batch = await extract('src/main.rs');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    // read_calls (3) + rejected_scoped_paths read (1) = 4 reads.
    // write_calls (5) + ActiveModel value-form (1 insert + 1 update + 1 delete) = 8 writes.
    expect(reads.length).toBe(4);
    expect(writes.length).toBe(8);
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('src/main.rs');
    const perf = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perf.length).toBe(interactions(batch).length);
  });

  it('rejects lowercase identifier `find()` (not an entity)', async () => {
    const batch = await extract('src/main.rs');
    const reads = interactions(batch).filter((i) => i.operation === 'read');
    // 3 (read_calls) + 1 (rejected_scoped_paths uses User::find via
    // a filter chain, which is itself a read) = 4. Bare find()
    // contributes 0.
    expect(reads.length).toBe(4);
  });

  it('write operations carry the expected canonical op', async () => {
    const batch = await extract('src/main.rs');
    const writes = interactions(batch).filter((i) => i.operation !== 'read');
    const ops = writes.map((i) => i.operation).sort();
    // Scoped-path writes (5):
    //   2 inserts (write) + 1 update_many (update) + 2 deletes
    // ActiveModel value-form (3):
    //   1 insert (write) + 1 update + 1 delete
    expect(ops).toEqual(['delete', 'delete', 'delete', 'update', 'update', 'write', 'write', 'write']);
  });

  it('handles update_many as update (not write)', async () => {
    const batch = await extract('src/main.rs');
    const updates = interactions(batch).filter((i) => i.operation === 'update');
    // 1 from scoped-path update_many + 1 from ActiveModel value-form
    expect(updates.length).toBe(2);
  });

  it('rejects SeaORM internal types `Column`, `Relation`, `ActiveModel`, etc.', async () => {
    const batch = await extract('src/main.rs');
    const tableNames = tables(batch).map((t) => t.name);
    // The reject list prevents 'column' / 'relation' from being
    // synthesized via the User::Column::* / User::Relation::* paths.
    expect(tableNames).not.toContain('column');
    expect(tableNames).not.toContain('relation');
    expect(tableNames).not.toContain('active_model');
  });

  it('detects ActiveModel value-form writes with inferred confidence', async () => {
    const batch = await extract('src/main.rs');
    const inferred = interactions(batch).filter((i) => i.confidence === 'inferred');
    // active_model_value_form: 1 insert
    // active_model_pascal: 1 update + 1 delete
    expect(inferred.length).toBe(3);
    const ops = inferred.map((i) => i.operation).sort();
    expect(ops).toEqual(['delete', 'update', 'write']);
  });

  it('cross-file: resolves Product entity from a different file via the project scan', async () => {
    // handlers.rs has `pub use crate::entities::Entity as Product;`
    // and `Product::find()`. entities.rs has
    // `#[sea_orm(table_name = "products")]`. The visitor must
    // resolve Product → products via the project-wide pre-scan.
    const batch = await extract('src/handlers.rs');
    const productTable = tables(batch).find((t) => t.name === 'products');
    expect(productTable).toBeTruthy();
    const reads = interactions(batch).filter((i) => i.operation === 'read');
    expect(reads.length).toBe(1);  // Product::find
  });
});
