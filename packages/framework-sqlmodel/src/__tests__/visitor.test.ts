import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DatabaseInteraction, DatabaseTable, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { SqlmodelPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/sqlmodel/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new SqlmodelPlugin();
  const py = new PyLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'sqlmodel-fixture',
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

describe('framework-sqlmodel visitor', () => {
  it('emits interactions for session.add / merge / get / select', async () => {
    const batch = await extract('svc.py');
    expect(interactions(batch).length).toBeGreaterThanOrEqual(6);
  });

  it('synthesizes a DatabaseTable per SQLModel class', async () => {
    const batch = await extract('svc.py');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('Hero');
    expect(names).toContain('Team');
  });

  it('every interaction carries orm="sqlmodel"', async () => {
    const batch = await extract('svc.py');
    for (const i of interactions(batch)) expect(i.orm).toBe('sqlmodel');
  });

  it('emits WRITES with insert (add) and update (merge) kinds', async () => {
    const batch = await extract('svc.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
  });

  it('emits READS for select(...) / session.get(...)', async () => {
    const batch = await extract('svc.py');
    const reads = batch.edges.filter((e) => e.edgeType === 'READS');
    expect(reads.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects all emits in files without sqlmodel import', async () => {
    const batch = await extract('no_imports.py');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
