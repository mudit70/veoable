import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DatabaseColumn,
  type DatabaseInteraction,
  type DatabaseTable,
  type SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { DieselPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/diesel/basic');

async function extract(file: string): Promise<NodeBatch> {
  const diesel = new DieselPlugin();
  const rust = new RustLanguagePlugin();
  diesel.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    repository: 'diesel-fixture',
    files: ['src/main.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(diesel.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');
const columns = (b: { nodes: SchemaNode[] }): DatabaseColumn[] =>
  b.nodes.filter((n): n is DatabaseColumn => n.nodeType === 'DatabaseColumn');
const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');

describe('framework-diesel visitor (#439)', () => {
  it('emits a DatabaseTable per diesel::table! macro', async () => {
    const batch = await extract('src/main.rs');
    const names = tables(batch).map((t) => t.name).sort();
    expect(names).toEqual(['orders', 'users']);
  });

  it('emits DatabaseColumn nodes with SQL types and primary-key markers', async () => {
    const batch = await extract('src/main.rs');
    const userCols = columns(batch).filter((c) => c.name === 'id' || c.name === 'email' || c.name === 'name');
    expect(userCols.length).toBeGreaterThanOrEqual(3);

    const id = userCols.find((c) => c.name === 'id');
    expect(id?.isPrimaryKey).toBe(true);
    expect(id?.type).toBe('BigInt');

    const email = userCols.find((c) => c.name === 'email');
    expect(email?.isPrimaryKey).toBe(false);
    expect(email?.type).toBe('Text');

    const name = userCols.find((c) => c.name === 'name');
    expect(name?.type).toBe('Nullable<Text>');
    expect(name?.nullable).toBe(true); // detected from Nullable< prefix
  });

  it('emits a DatabaseInteraction per recognized diesel call site', async () => {
    const batch = await extract('src/main.rs');
    const ops = interactions(batch).map((i) => i.operation).sort();
    // Reads: list_users (load), find_user (first), list_orders_for
    // (get_results), count_users (get_result walking through
    // .count()). Writes: create_user (insert), touch_user (update),
    // purge_user (delete), plus the two #442 bare-form positives —
    // create_user_bare (insert) and purge_user_bare (delete) — that
    // ride the file-level `use diesel::prelude::*;` glob.
    expect(ops).toEqual([
      'delete', 'delete',                       // purge_user + purge_user_bare
      'read', 'read', 'read', 'read',           // 4 reads
      'update',                                  // touch_user
      'write', 'write',                          // create_user + create_user_bare
    ]);
  });

  it('routes READS edges to the right table (users vs orders)', async () => {
    const batch = await extract('src/main.rs');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    const tableIds = new Set(tables(batch).map((t) => t.id));
    for (const r of reads) {
      expect(tableIds.has(r.to)).toBe(true);
    }
    // At least one read must target orders (list_orders_for) and
    // at least one must target users (list_users + find_user).
    const orderTable = tables(batch).find((t) => t.name === 'orders')!;
    const userTable = tables(batch).find((t) => t.name === 'users')!;
    expect(reads.some((r) => r.to === orderTable.id)).toBe(true);
    expect(reads.some((r) => r.to === userTable.id)).toBe(true);
  });

  it('marks every interaction with orm=diesel and direct confidence', async () => {
    const batch = await extract('src/main.rs');
    for (const i of interactions(batch)) {
      expect(i.orm).toBe('diesel');
      expect(i.confidence).toBe('direct');
    }
  });

  it('does NOT emit a table for a non-diesel macro that shares a shape', async () => {
    const batch = await extract('src/main.rs');
    expect(tables(batch).map((t) => t.name)).not.toContain('audit_log');
  });

  it('does NOT emit an interaction for dynamic_insert (local-variable receiver)', async () => {
    const batch = await extract('src/main.rs');
    // 9 expected: 4 reads + insert/update/delete (fully-scoped) + 2
    // bare-form positives (insert + delete) under #442. If
    // dynamic_insert leaked we'd see 10.
    expect(interactions(batch).length).toBe(9);
  });

  it('marks the DatabaseTable as declaredIn the source file', async () => {
    const batch = await extract('src/main.rs');
    const users = tables(batch).find((t) => t.name === 'users')!;
    expect(users.declaredIn).toBeTruthy();
  });

  // ── #442: bare-form detection via file-local imports ─────────────

  it('detects bare insert_into / update / delete after `use diesel::{...};` (#442)', async () => {
    const batch = await extract('src/bare_form.rs');
    // create_session (insert), rotate_token (update), drop_session
    // (delete). All call sites use the unprefixed form. The visitor
    // accepts them because the file has
    //   use diesel::insert_into;
    //   use diesel::{update, delete};
    const ops = interactions(batch).map((i) => i.operation).sort();
    expect(ops).toEqual(['delete', 'update', 'write']);
  });

  it('also picks up the diesel::table! declaration in the bare-form file', async () => {
    const batch = await extract('src/bare_form.rs');
    expect(tables(batch).map((t) => t.name)).toContain('sessions');
  });

  it('does NOT register bare calls in a file that has no `use diesel`', async () => {
    // no_diesel.rs defines its own insert_into / update / delete
    // free functions. Without a `use diesel::...` import, the
    // visitor must reject every call.
    const batch = await extract('src/no_diesel.rs');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
