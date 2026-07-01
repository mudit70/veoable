import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DatabaseInteraction, DatabaseTable, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { EntPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/ent/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new EntPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-ent visitor', () => {
  it('emits one interaction per client.<Entity>.<Method>() call', async () => {
    const batch = await extract('svc.go');
    // createUser, listUsers, getUser, updateUser, deleteUser,
    // createOrder, queryOrders = 7
    expect(interactions(batch).length).toBe(7);
  });

  it('synthesizes a DatabaseTable per entity', async () => {
    const batch = await extract('svc.go');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('User');
    expect(names).toContain('Order');
  });

  it('every interaction carries orm="ent"', async () => {
    const batch = await extract('svc.go');
    for (const i of interactions(batch)) expect(i.orm).toBe('ent');
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('svc.go');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('delete')).toBe(true);
  });

  it('emits READS for Query/Get', async () => {
    const batch = await extract('svc.go');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects all emits in files without ent import', async () => {
    const batch = await extract('no_imports.go');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
