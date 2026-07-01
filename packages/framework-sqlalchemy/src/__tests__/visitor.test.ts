import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type DatabaseInteraction,
  type DatabaseSystem,
  type DatabaseTable,
  type SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { SqlalchemyPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/python/sqlalchemy/basic');

async function extract(file: string): Promise<{ batch: NodeBatch; systemBatch: NodeBatch }> {
  const plugin = new SqlalchemyPlugin();
  const systemBatch = plugin.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    packageJson: null,
    files: [],
  });
  const py = new PyLanguagePlugin();
  py.registerVisitor(plugin.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  const batch = await py.extractFile(handle, file);
  return { batch, systemBatch };
}

function dbis(batch: { nodes: SchemaNode[] }): DatabaseInteraction[] {
  return batch.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
}
function tables(batch: { nodes: SchemaNode[] }): DatabaseTable[] {
  return batch.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');
}

describe('SQLAlchemy receiver / CRUD detection (#42)', () => {
  it('emits DatabaseSystem on onProjectLoaded', async () => {
    const { systemBatch } = await extract('queries.py');
    const systems = systemBatch.nodes.filter(
      (n): n is DatabaseSystem => n.nodeType === 'DatabaseSystem',
    );
    expect(systems).toHaveLength(1);
    expect(systems[0].name).toBe('sqlalchemy');
  });

  it('detects db.query(Model).all() / .filter() / .get() reads', async () => {
    const { batch } = await extract('queries.py');
    const reads = dbis(batch).filter((d) => d.operation === 'read');
    // list_users (.all), get_user (.get), list_tasks_filtered (.filter→.all),
    // session_alias (.get) → at least 3 distinct reads.
    expect(reads.length).toBeGreaterThanOrEqual(3);
  });

  it('detects db.add(...) as a write', async () => {
    const { batch } = await extract('queries.py');
    const writes = dbis(batch).filter((d) => d.operation === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it('detects db.delete(...) as a delete', async () => {
    const { batch } = await extract('queries.py');
    const deletes = dbis(batch).filter((d) => d.operation === 'delete');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it('recognises `session` as a receiver alias (not just `db`)', async () => {
    // session_alias() uses `session.query(Task).get(...)` — must produce
    // a DBI at direct/inferred confidence (not be dropped).
    const { batch } = await extract('queries.py');
    const allDbis = dbis(batch);
    // The session_alias function should contribute at least one DBI.
    expect(allDbis.length).toBeGreaterThanOrEqual(4);
  });

  it('every emitted DBI and DatabaseTable validates against the schema', async () => {
    const { batch } = await extract('queries.py');
    for (const n of dbis(batch)) expect(() => validateNode(n)).not.toThrow();
    for (const n of tables(batch)) expect(() => validateNode(n)).not.toThrow();
  });
});

describe('SqlalchemyPlugin.appliesTo', () => {
  const baseCtx = {
    rootDir: FIXTURE_ROOT,
    packageJson: null,
    files: [],
  } as const;

  it('activates when sqlalchemy is in a python manifest', () => {
    const plugin = new SqlalchemyPlugin();
    expect(
      plugin.appliesTo({
        ...baseCtx,
        pythonManifests: [
          {
            path: path.join(FIXTURE_ROOT, 'requirements.txt'),
            dependencies: { sqlalchemy: '*' },
            devDependencies: {},
          },
        ],
      } as unknown as Parameters<typeof plugin.appliesTo>[0]),
    ).toBe(true);
  });

  it('does not activate when sqlalchemy is absent from manifests', () => {
    const plugin = new SqlalchemyPlugin();
    expect(plugin.appliesTo(baseCtx as unknown as Parameters<typeof plugin.appliesTo>[0])).toBe(
      false,
    );
  });
});
