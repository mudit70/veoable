import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DatabaseInteraction, DatabaseTable, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { TortoisePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/tortoise/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new TortoisePlugin();
  const py = new PyLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'tortoise-fixture',
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

describe('framework-tortoise visitor', () => {
  it('emits interactions on Model.<verb>() and queryset chains', async () => {
    const batch = await extract('svc.py');
    // Each fixture call emits AT LEAST one interaction. Chained calls
    // emit one per recognised verb in the chain (e.g.
    // `User.filter(...).update(...)` emits two: filter→read AND
    // update→update).
    expect(interactions(batch).length).toBeGreaterThanOrEqual(11);
  });

  it('attributes queryset-chain updates back to the Model class', async () => {
    const batch = await extract('svc.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const updateTables = new Set<string>();
    for (const w of writes) {
      if (w.kind === 'update') {
        const t = tables(batch).find((tt) => tt.id === w.to);
        if (t) updateTables.add(t.name);
      }
    }
    expect(updateTables.has('User')).toBe(true);
  });

  it('synthesizes DatabaseTable per Model class', async () => {
    const batch = await extract('svc.py');
    const names = tables(batch).map((t) => t.name);
    expect(names).toContain('User');
    expect(names).toContain('Order');
  });

  it('every interaction carries orm="tortoise"', async () => {
    const batch = await extract('svc.py');
    for (const i of interactions(batch)) expect(i.orm).toBe('tortoise');
  });

  it('emits WRITES with insert/update/delete kinds', async () => {
    const batch = await extract('svc.py');
    const writes = batch.edges.filter((e) => e.edgeType === 'WRITES');
    const kinds = new Set(writes.map((e) => e.kind));
    expect(kinds.has('insert')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('delete')).toBe(true);
  });

  it('rejects all emits in files without tortoise import', async () => {
    const batch = await extract('no_imports.py');
    expect(interactions(batch)).toEqual([]);
    expect(tables(batch)).toEqual([]);
  });
});
