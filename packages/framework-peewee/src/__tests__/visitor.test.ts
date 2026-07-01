import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DatabaseInteraction, DatabaseTable, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { PeeweePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/peewee/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new PeeweePlugin();
  const py = new PyLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'peewee-fixture',
    files: ['svc.py', 'no_imports.py'],
    packageJson: null,
  } as any);
  py.registerVisitor(plugin.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const interactions = (b: { nodes: SchemaNode[] }): DatabaseInteraction[] =>
  b.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
const tables = (b: { nodes: SchemaNode[] }): DatabaseTable[] =>
  b.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');

describe('framework-peewee visitor', () => {
  it('emits one interaction per Model CRUD call', async () => {
    const batch = await extract('svc.py');
    // create_user, list_users, get_user, get_or_none_user,
    // update_user, delete_user, create_order, list_orders = 8
    expect(interactions(batch).length).toBe(8);
  });

  it('synthesizes a DatabaseTable per Model class name', async () => {
    const batch = await extract('svc.py');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('User');
    expect(names).toContain('Order');
  });

  it('every interaction carries orm="peewee"', async () => {
    const batch = await extract('svc.py');
    for (const i of interactions(batch)) expect(i.orm).toBe('peewee');
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('svc.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('delete')).toBe(true);
  });

  it('emits READS for select/get/get_or_none', async () => {
    const batch = await extract('svc.py');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects all emits in files without peewee import', async () => {
    const batch = await extract('no_imports.py');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
