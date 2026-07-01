import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DatabaseInteraction,
  type DatabaseTable,
  type SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { SqlxPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/sqlx/basic');

async function extract(file: string): Promise<NodeBatch> {
  const sqlx = new SqlxPlugin();
  const rust = new RustLanguagePlugin();
  // Trigger onProjectLoaded so the system + visitor are constructed.
  sqlx.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'sqlx-fixture',
    files: ['src/main.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(sqlx.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

function tables(batch: { nodes: SchemaNode[] }): DatabaseTable[] {
  return batch.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');
}
function interactions(batch: { nodes: SchemaNode[] }): DatabaseInteraction[] {
  return batch.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
}

describe('framework-sqlx visitor (#439)', () => {
  it('synthesizes a DatabaseTable per distinct table name observed', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name).sort();
    // users (read+update), orders (read), sessions (insert), carts (delete).
    // Negative-case fixtures (CREATE TABLE audit_log, dynamic SQL) must
    // not produce a table.
    expect(names).toEqual(['carts', 'orders', 'sessions', 'users']);
  });

  it('emits a DatabaseInteraction per matched sqlx call', async () => {
    const batch = await extract('src/main.rs');
    const ops = interactions(batch).map((i) => i.operation).sort();
    // 5 positives: read (users), read (orders), insert (sessions),
    // delete (carts), update (users). Negative-cases (CREATE TABLE,
    // dynamic SQL) emit no interaction.
    expect(ops).toEqual(['delete', 'read', 'read', 'update', 'write']);
  });

  it('marks every interaction with orm=sqlx and direct confidence', async () => {
    const batch = await extract('src/main.rs');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('sqlx');
      expect(i.confidence).toBe('direct');
    }
  });

  it('emits READS edge for SELECT, WRITES edge for INSERT/UPDATE/DELETE', async () => {
    const batch = await extract('src/main.rs');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS').length;
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES').length;
    expect(reads).toBe(2);
    expect(writes).toBe(3);
  });

  it('does NOT emit a DatabaseInteraction for DDL (CREATE TABLE)', async () => {
    const batch = await extract('src/main.rs');
    // audit_log is the CREATE TABLE target — should never appear.
    expect(tables(batch).map((t) => t.name)).not.toContain('audit_log');
  });

  it('does NOT emit a DatabaseInteraction when SQL is built from a variable', async () => {
    const batch = await extract('src/main.rs');
    // The dynamic() function in the fixture passes `&sql` (a format!
    // string) to sqlx::query(). No string literal at the call site,
    // so nothing to extract.
    const dynamicOnly = interactions(batch).filter((i) => i.rawQuery?.includes('{}'));
    expect(dynamicOnly.length).toBe(0);
  });

  it('strips schema prefix on the table name (public.orders → orders)', async () => {
    const batch = await extract('src/main.rs');
    expect(tables(batch).map((t) => t.name)).toContain('orders');
    expect(tables(batch).map((t) => t.name)).not.toContain('public.orders');
  });

  it('extracts SQL from query_as!(Type, "SELECT ...") even with the leading type identifier', async () => {
    // The fixture's list_users() uses
    //   sqlx::query_as!(User, "SELECT id, email FROM users")
    // Confirm the visitor pulls the SQL from the SECOND token-tree
    // slot (the first is the User type identifier) and that
    // 'users' surfaces as a read DatabaseInteraction.
    const batch = await extract('src/main.rs');
    const usersReads = interactions(batch).filter(
      (i) => i.operation === 'read' && i.rawQuery?.includes('FROM users'),
    );
    expect(usersReads.length).toBe(1);
    // And the 'User' identifier MUST NOT have been mis-extracted as
    // a table — query_as!'s type arg should never reach the SQL
    // parser.
    expect(tables(batch).map((t) => t.name)).not.toContain('User');
  });
});
