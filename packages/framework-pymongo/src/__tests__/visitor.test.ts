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
import { PymongoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/pymongo/basic');

async function extract(file: string): Promise<NodeBatch> {
  const pymongo = new PymongoPlugin();
  const py = new PyLanguagePlugin();
  pymongo.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'pymongo-fixture',
    files: ['store.py', 'no_imports.py'],
    packageJson: null,
  } as any);
  py.registerVisitor(pymongo.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-pymongo visitor', () => {
  it('emits one DatabaseInteraction per collection-method call', async () => {
    const batch = await extract('store.py');
    // Counts:
    //   users.find, find_one, count_documents, insert_one, insert_many,
    //   update_one, update_many, replace_one, delete_one, delete_many,
    //   aggregate — 11
    //   orders.find_one_and_update, find — 2
    //   products.find — 1
    //   db.events.find_one, db['events'].insert_one — 2
    //   self.orders.find_one — 1
    // = 17 interactions. unrelated_find on "hello" must NOT emit.
    expect(interactions(batch).length).toBe(17);
  });

  it('synthesizes DatabaseTable nodes for every observed collection', async () => {
    const batch = await extract('store.py');
    const names = tables(batch).map((t) => t.name).sort();
    expect(names).toEqual(['events', 'orders', 'products', 'users']);
  });

  it('every DatabaseTable has kind="collection"', async () => {
    const batch = await extract('store.py');
    for (const t of tables(batch)) {
      expect(t.kind).toBe('collection');
    }
  });

  it('every interaction carries orm="pymongo" and confidence="direct"', async () => {
    const batch = await extract('store.py');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('pymongo');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS for read methods', async () => {
    const batch = await extract('store.py');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    // users.find + users.find_one + users.count_documents +
    // users.aggregate + orders.find + products.find +
    // db.events.find_one + self.orders.find_one = 8 reads.
    // (find_one_and_update is classified as update, not read.)
    expect(reads.length).toBe(8);
  });

  it('emits WRITES with correct kind (insert/update/delete) per op', async () => {
    const batch = await extract('store.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = writes.map((e) => e.kind).sort();
    // Inserts: insert_one, insert_many, db['events'].insert_one = 3
    // Updates: update_one, update_many, replace_one, find_one_and_update = 4
    // Deletes: delete_one, delete_many = 2
    expect(kinds).toEqual(
      ['delete', 'delete', 'insert', 'insert', 'insert', 'update', 'update', 'update', 'update'],
    );
  });

  it('resolves collection name from bracket form (db["users"])', async () => {
    const batch = await extract('store.py');
    const userOps = interactions(batch).filter((i) => {
      const e = batch.edges.find(
        (ed) => (ed.edgeType === 'READS' || ed.edgeType === 'WRITES') && ed.from === i.id,
      );
      const usersTable = tables(batch).find((t) => t.name === 'users');
      return e?.to === usersTable?.id;
    });
    expect(userOps.length).toBeGreaterThan(0);
  });

  it('resolves collection name from attribute form (db.orders)', async () => {
    const batch = await extract('store.py');
    const ordersTable = tables(batch).find((t) => t.name === 'orders');
    expect(ordersTable).toBeTruthy();
  });

  it('resolves collection from nested-subscript binding (client["mydb"]["products"])', async () => {
    const batch = await extract('store.py');
    const productsTable = tables(batch).find((t) => t.name === 'products');
    expect(productsTable).toBeTruthy();
  });

  it('handles `db.events.find_one(...)` direct attribute access on db', async () => {
    const batch = await extract('store.py');
    const eventsTable = tables(batch).find((t) => t.name === 'events');
    expect(eventsTable).toBeTruthy();
  });

  it('handles self.<coll> binding pattern inside a class', async () => {
    const batch = await extract('store.py');
    // The OrderRepo class binds `self.orders = db['orders']` and
    // calls `self.orders.find_one(...)`. The visitor's resolver
    // sees `self.orders` as an attribute → extracts `orders` as
    // the collection name.
    const ordersInteractions = interactions(batch).filter((i) => {
      const e = batch.edges.find(
        (ed) => (ed.edgeType === 'READS' || ed.edgeType === 'WRITES') && ed.from === i.id,
      );
      const ordersTable = tables(batch).find((t) => t.name === 'orders');
      return e?.to === ordersTable?.id;
    });
    expect(ordersInteractions.length).toBe(3);
    // find_one_and_update (update) + find (read) + self.orders.find_one (read)
  });

  it('rejects string.find(substring) lookalike on a non-collection', async () => {
    const batch = await extract('store.py');
    // The fixture's `unrelated_find` calls `"hello".find("ell")` —
    // identifier `s` is NOT in the collection-binding map, so the
    // visitor declines. If it leaked, an `ell` or `s` table would
    // appear.
    const tableNames = tables(batch).map((t) => t.name);
    expect(tableNames).not.toContain('s');
    expect(tableNames).not.toContain('ell');
    expect(tableNames).not.toContain('hello');
  });

  it('rejects all emits in a file with no pymongo/motor import', async () => {
    const batch = await extract('no_imports.py');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });

  it('does NOT bind `db = client["mydb"]` as a collection (database vs collection)', async () => {
    // Regression for reviewer must-fix: pre-fix the binding scanner
    // mapped `db → 'mydb'`. Then `db.aggregate([...])` (a valid
    // pymongo Database method) emitted a phantom 'mydb' collection.
    // The two-pass identifyDatabaseIdentifiers pass marks `db` as a
    // database, so no `mydb` table ever appears.
    const batch = await extract('store.py');
    const tableNames = tables(batch).map((t) => t.name);
    expect(tableNames).not.toContain('mydb');
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('store.py');
    const perfEdges = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perfEdges.length).toBe(interactions(batch).length);
  });
});
