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
import { MongogoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/mongogo/basic');

async function extract(file: string): Promise<NodeBatch> {
  const mongogo = new MongogoPlugin();
  const go = new GoLanguagePlugin();
  mongogo.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'mongogo-fixture',
    files: ['store.go'],
    packageJson: null,
  } as any);
  go.registerVisitor(mongogo.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-mongogo visitor', () => {
  it('emits one DatabaseInteraction per collection-method call', async () => {
    const batch = await extract('store.go');
    // users.{FindOne, Find, InsertOne, InsertMany, UpdateOne,
    //        UpdateMany, ReplaceOne, DeleteOne, DeleteMany,
    //        Aggregate, CountDocuments} = 11
    // orders.{FindOneAndUpdate, Find} = 2
    // ShortVarDecl: products.Find = 1
    // Repo.events.Find = 1 (selector binding)
    // = 15 interactions. kv.FindOne (negative) must NOT emit.
    expect(interactions(batch).length).toBe(15);
  });

  it('synthesizes DatabaseTable nodes per collection', async () => {
    const batch = await extract('store.go');
    const names = tables(batch).map((t) => t.name).sort();
    expect(names).toEqual(['events', 'orders', 'products', 'users']);
    for (const t of tables(batch)) expect(t.kind).toBe('collection');
  });

  it('every interaction carries orm="mongogo" and confidence="direct"', async () => {
    const batch = await extract('store.go');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('mongogo');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS for read methods', async () => {
    const batch = await extract('store.go');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    // users.{FindOne, Find, Aggregate, CountDocuments} = 4 +
    // orders.Find = 1 + products.Find = 1 + events.Find = 1
    // = 7 reads (FindOneAndUpdate is classified as update).
    expect(reads.length).toBe(7);
  });

  it('emits WRITES with correct kinds per op', async () => {
    const batch = await extract('store.go');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = writes.map((e) => e.kind).sort();
    // users writes: InsertOne, InsertMany (2 insert)
    //               UpdateOne, UpdateMany, ReplaceOne (3 update)
    //               DeleteOne, DeleteMany (2 delete)
    // orders writes: FindOneAndUpdate (1 update)
    // = 8 writes: 2 delete + 2 insert + 4 update
    expect(kinds).toEqual([
      'delete', 'delete', 'insert', 'insert', 'update', 'update', 'update', 'update',
    ]);
  });

  it('resolves collection name via `users := db.Collection("users")` package-level binding', async () => {
    const batch = await extract('store.go');
    const usersTable = tables(batch).find((t) => t.name === 'users');
    expect(usersTable).toBeTruthy();
  });

  it('resolves collection name via `:=` short-var declaration inside a function', async () => {
    const batch = await extract('store.go');
    const products = tables(batch).find((t) => t.name === 'products');
    expect(products).toBeTruthy();
  });

  it('resolves collection name via selector binding `r.events = db.Collection("events")`', async () => {
    const batch = await extract('store.go');
    const events = tables(batch).find((t) => t.name === 'events');
    expect(events).toBeTruthy();
  });

  it('rejects unrelated `kv.FindOne(...)` (collection name not resolved)', async () => {
    const batch = await extract('store.go');
    const tableNames = tables(batch).map((t) => t.name);
    expect(tableNames).not.toContain('k');
    expect(tableNames).not.toContain('kv');
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('store.go');
    const perfEdges = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perfEdges.length).toBe(interactions(batch).length);
  });
});

// Cross-file helper-function resolution.
//
// The plugin's onProjectLoaded scans every .go file in the project
// for `func X(...) *mongo.Collection { ...Collection("foo") }`
// signatures and threads the resulting map into the visitor.
// Callers can then write `col := db.X(...)` in a different file and
// still get a DatabaseInteraction emitted.
describe('framework-mongogo cross-file helpers', () => {
  const HELPERS_ROOT = path.resolve(
    __dirname,
    '../../../../tests/fixtures/mongogo/helpers',
  );

  async function extractHelpers(file: string): Promise<NodeBatch> {
    const mongogo = new MongogoPlugin();
    const go = new GoLanguagePlugin();
    mongogo.onProjectLoaded({
      rootDir: HELPERS_ROOT,
      repository: 'helpers-fixture',
      files: ['db/mongo.go', 'handlers/vehicles.go'],
      packageJson: null,
    } as any);
    go.registerVisitor(mongogo.visitor);
    const handle = await go.loadProject({ rootDir: HELPERS_ROOT });
    return go.extractFile(handle, file);
  }

  it('resolves db.Vehicles(c) → vehicles via the cross-file helper map', async () => {
    const batch = await extractHelpers('handlers/vehicles.go');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('vehicles');
  });

  it('resolves db.Pings(c) → pings via the cross-file helper map', async () => {
    const batch = await extractHelpers('handlers/vehicles.go');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('pings');
  });

  it('emits at least four DatabaseInteraction nodes from helpers/vehicles.go', async () => {
    const batch = await extractHelpers('handlers/vehicles.go');
    // List → CountDocuments, GetOne → FindOne, InsertPing → InsertOne,
    // UpdateVehicle → UpdateOne
    expect(interactions(batch).length).toBeGreaterThanOrEqual(4);
  });
});
