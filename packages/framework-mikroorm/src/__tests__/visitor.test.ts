import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { idFor, type DatabaseInteraction, type DatabaseTable } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { MikroOrmPlugin } from '../mikroorm-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/mikroorm');
const fixturePath = (s: string) => path.join(FIXTURE_ROOT, s);

const SYSTEM_ID = idFor.databaseSystem({ kind: 'postgres', name: 'mikroorm' });
const tableId = (name: string): string =>
  idFor.databaseTable({ systemId: SYSTEM_ID, schema: null, name });

async function extractAll(scenario: string, files: string[]): Promise<NodeBatch[]> {
  const plugin = new MikroOrmPlugin();
  plugin.onProjectLoaded({ rootDir: fixturePath(scenario), packageJson: null, files: [] });
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  const batches: NodeBatch[] = [];
  for (const f of files) batches.push(await ts.extractFile(handle, f));
  return batches;
}

function tables(b: NodeBatch): DatabaseTable[] {
  return b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');
}
function dbis(b: NodeBatch): DatabaseInteraction[] {
  return b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
}

describe('MikroORM (#372)', () => {
  let entityBatch: NodeBatch;
  let serviceBatch: NodeBatch;
  beforeAll(async () => {
    const batches = await extractAll('basic', ['src/user.entity.ts', 'src/users.service.ts']);
    entityBatch = batches[0];
    serviceBatch = batches[1];
  });

  it('extracts @Entity({ tableName }) and @Entity() default-named entities', () => {
    const names = tables(entityBatch).map((t) => t.name).sort();
    expect(names).toContain('users');
    expect(names).toContain('comment');
  });

  it('routes EntityRepository<User> calls to the @Entity("users") table id', () => {
    const directDbis = dbis(serviceBatch).filter((d) => d.confidence === 'direct');
    expect(directDbis.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(directDbis.map((d) => d.id));
    const targets = new Set(
      serviceBatch.edges
        .filter((e) => e.edgeType === 'READS' || e.edgeType === 'WRITES')
        .filter((e) => ids.has(e.from))
        .map((e) => e.to),
    );
    expect(targets.has(tableId('users'))).toBe(true);
    expect(targets.has(tableId('user'))).toBe(false);
  });

  it('handles EntityManager em.find(User) pattern', () => {
    const directs = dbis(serviceBatch).filter((d) => d.confidence === 'direct');
    expect(directs.length).toBeGreaterThanOrEqual(5);
  });
});

describe('MikroORM EntitySchema builder (#383)', () => {
  let batch: NodeBatch;
  beforeAll(async () => {
    [batch] = await extractAll('entityschema', ['src/schemas.ts']);
  });

  it('emits a DatabaseTable for `new EntitySchema({ tableName })`', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('users')).toBe(true);
  });

  it('falls back to `name` field when `tableName` is absent', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('posts')).toBe(true);
  });

  it('emits DatabaseColumn for each entry in `properties`', () => {
    const usersTableId = tableId('users');
    const cols = batch.nodes
      .filter((n) => n.nodeType === 'DatabaseColumn')
      .filter((n) => (n as { tableId: string }).tableId === usersTableId);
    const names = cols.map((c) => (c as { name: string }).name).sort();
    expect(names).toEqual(['email', 'id', 'name']);
  });

  it('marks `primary: true` columns as isPrimaryKey', () => {
    const usersTableId = tableId('users');
    const idCol = batch.nodes
      .filter((n) => n.nodeType === 'DatabaseColumn')
      .find((n) => (n as { tableId: string; name: string }).tableId === usersTableId && (n as { name: string }).name === 'id');
    expect(idCol).toBeDefined();
    expect((idCol as { isPrimaryKey: boolean }).isPrimaryKey).toBe(true);
  });
});

describe('MikroORM Medusa v2 model.define (#383)', () => {
  let batch: NodeBatch;
  beforeAll(async () => {
    [batch] = await extractAll('medusa-model', ['src/product.ts']);
  });

  it('emits a DatabaseTable for each `model.define(<name>, ...)` call', () => {
    const names = new Set(tables(batch).map((t) => t.name));
    expect(names.has('product')).toBe(true);
    expect(names.has('variant')).toBe(true);
  });

  it('emits DatabaseColumn for each key in the second arg object', () => {
    const productTableId = tableId('product');
    const cols = batch.nodes
      .filter((n) => n.nodeType === 'DatabaseColumn')
      .filter((n) => (n as { tableId: string }).tableId === productTableId)
      .map((c) => (c as { name: string }).name)
      .sort();
    expect(cols).toEqual(['created_at', 'description', 'id', 'metadata', 'price', 'title']);
  });
});

describe('MikroORM model.define column meta (#396)', () => {
  let batch: NodeBatch;
  beforeAll(async () => {
    [batch] = await extractAll('medusa-model', ['src/product.ts']);
  });

  const colFor = (tableName: string, columnName: string) =>
    batch.nodes
      .filter((n) => n.nodeType === 'DatabaseColumn')
      .find(
        (n) =>
          (n as { tableId: string }).tableId === tableId(tableName) &&
          (n as { name: string }).name === columnName,
      ) as { type: string | null; nullable: boolean; isPrimaryKey: boolean } | undefined;

  it('extracts type from the head model.<type>(...) call', () => {
    expect(colFor('product', 'id')?.type).toBe('id');
    expect(colFor('product', 'title')?.type).toBe('text');
    expect(colFor('product', 'price')?.type).toBe('number');
    expect(colFor('product', 'created_at')?.type).toBe('date');
    expect(colFor('product', 'metadata')?.type).toBe('json');
    expect(colFor('variant', 'in_stock')?.type).toBe('boolean');
  });

  it('marks .primaryKey()-modified columns as isPrimaryKey', () => {
    expect(colFor('product', 'id')?.isPrimaryKey).toBe(true);
    expect(colFor('variant', 'id')?.isPrimaryKey).toBe(true);
    // Columns without primaryKey() must NOT be marked.
    expect(colFor('product', 'title')?.isPrimaryKey).toBe(false);
  });

  it('marks .nullable()-modified columns as nullable', () => {
    expect(colFor('product', 'description')?.nullable).toBe(true);
    expect(colFor('product', 'metadata')?.nullable).toBe(true);
    expect(colFor('product', 'title')?.nullable).toBe(false);
  });

  it('ignores .unique() / .index() / .searchable() modifiers without bailing', () => {
    // These should still produce a column with the correct type.
    expect(colFor('variant', 'sku')?.type).toBe('text');
    expect(colFor('variant', 'product_id')?.type).toBe('text');
    expect(colFor('product', 'title')?.type).toBe('text'); // .searchable() tail
  });
});

describe('MikroOrmPlugin.appliesTo', () => {
  it('activates on @mikro-orm/core', () => {
    const plugin = new MikroOrmPlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: { dependencies: { '@mikro-orm/core': '^6.0.0' } }, files: [] })).toBe(true);
  });
  it('activates on @mikro-orm/postgresql (any subpackage)', () => {
    const plugin = new MikroOrmPlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: { dependencies: { '@mikro-orm/postgresql': '^6.0.0' } }, files: [] })).toBe(true);
  });
  it('does not activate without mikro-orm', () => {
    const plugin = new MikroOrmPlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: { dependencies: { express: '^4.0.0' } }, files: [] })).toBe(false);
  });
});
