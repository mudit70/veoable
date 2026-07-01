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
import { GosqlxPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/gosqlx/basic');

async function extract(file: string): Promise<NodeBatch> {
  const gosqlx = new GosqlxPlugin();
  const go = new GoLanguagePlugin();
  gosqlx.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'gosqlx-fixture',
    files: ['store.go'],
    packageJson: null,
  } as any);
  go.registerVisitor(gosqlx.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');
const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');

describe('framework-gosqlx visitor', () => {
  it('emits DatabaseInteractions for db.Get/Select/Exec', async () => {
    const batch = await extract('store.go');
    const ops = interactions(batch).map((i) => i.operation).sort();
    // GetUserByID → read on users
    // ListUsers → read on users
    // CreateUser → write on users (INSERT)
    // UpdateUserName → update on users
    // DeleteUser → delete on users
    // CreateOrderNamed → write on orders (INSERT)
    // SelectOrdersNamed → read on orders
    // QueryxUsers → read on users
    // QueryRowxUser → read on users
    // MustDeleteAll → delete on users
    // TxRoundtrip → write on audit (INSERT)
    // = 11 interactions.
    expect(ops.length).toBe(11);
  });

  it('synthesizes DatabaseTable nodes from observed table names', async () => {
    const batch = await extract('store.go');
    const names = tables(batch).map((t) => t.name).sort();
    expect(names).toEqual(['audit', 'orders', 'users']);
  });

  it('every interaction carries orm="gosqlx"', async () => {
    const batch = await extract('store.go');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('gosqlx');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS edges for read operations and WRITES for the rest', async () => {
    const batch = await extract('store.go');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    // 5 reads: GetUserByID, ListUsers, SelectOrdersNamed, QueryxUsers, QueryRowxUser
    // 6 writes: CreateUser, UpdateUserName, DeleteUser, CreateOrderNamed, MustDeleteAll, TxRoundtrip
    expect(reads.length).toBe(5);
    expect(writes.length).toBe(6);
  });

  it('emits PERFORMED_BY edges from interaction to enclosing function', async () => {
    const batch = await extract('store.go');
    const perfEdges = batch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(perfEdges.length).toBe(interactions(batch).length);
  });

  it('handles named-arg variants (NamedQuery / NamedExec)', async () => {
    const batch = await extract('store.go');
    const ordersInts = interactions(batch).filter((i) => {
      const t = tables(batch).find((tt) => tt.id === (
        batch.edges.find((e) => (e.edgeType === 'READS' || e.edgeType === 'WRITES') && e.from === i.id)?.to
      ));
      return t?.name === 'orders';
    });
    expect(ordersInts.length).toBe(2);
  });

  it('handles tx.Exec (the same methods work on *sqlx.Tx)', async () => {
    const batch = await extract('store.go');
    const auditTable = tables(batch).find((t) => t.name === 'audit');
    expect(auditTable).toBeTruthy();
    const auditInteraction = interactions(batch).find((i) => {
      const w = batch.edges.find((e) => e.edgeType === 'WRITES' && e.from === i.id);
      return w?.to === auditTable!.id;
    });
    expect(auditInteraction).toBeTruthy();
    expect(auditInteraction!.operation).toBe('write');
  });

  it('rejects `<bucket>.Get(literal)` (receiver name does not match)', async () => {
    const batch = await extract('store.go');
    // bucket.Get returns the key string; SHOULD NOT register as a
    // SQL read. If it did, a table called "users" (parsed from the
    // "SELECT * FROM users" arg) would appear with an extra
    // interaction.
    const userTable = tables(batch).find((t) => t.name === 'users');
    expect(userTable).toBeTruthy();
    // 5 read interactions on `users` (Get + Select + Queryx +
    // QueryRowx + MustDeleteAll's "users" target which is delete,
    // not read). Confirm there's no SIXTH bogus read coming from
    // bucket.Get.
    const userReadIxs = interactions(batch).filter((i) => {
      const r = batch.edges.find((e) => e.edgeType === 'READS' && e.from === i.id);
      return r?.to === userTable!.id;
    });
    expect(userReadIxs.length).toBe(4);
  });

  it('rejects `q.Queryx(...)` on a non-canonical receiver', async () => {
    const batch = await extract('store.go');
    const names = tables(batch).map((t) => t.name);
    expect(names).not.toContain('should_not_emit');
  });
});
