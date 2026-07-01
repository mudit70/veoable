import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { idFor, type DatabaseInteraction, type DatabaseTable } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { SequelizePlugin } from '../sequelize-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/sequelize');
const fixturePath = (s: string) => path.join(FIXTURE_ROOT, s);

const SYSTEM_ID = idFor.databaseSystem({ kind: 'postgres', name: 'sequelize' });
const tableId = (name: string): string =>
  idFor.databaseTable({ systemId: SYSTEM_ID, schema: null, name });

async function extractAll(scenario: string, files: string[]): Promise<NodeBatch[]> {
  const plugin = new SequelizePlugin();
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

describe('Sequelize (#367)', () => {
  let entityBatch: NodeBatch;
  let serviceBatch: NodeBatch;
  beforeAll(async () => {
    const batches = await extractAll('basic', ['src/user.model.ts', 'src/users.service.ts']);
    entityBatch = batches[0];
    serviceBatch = batches[1];
  });

  it('extracts @Table({ tableName }) entities', () => {
    const names = new Set(tables(entityBatch).map((t) => t.name));
    expect(names.has('users')).toBe(true);
  });

  it('pluralises class name for plain `extends Model` classes (Photo → photos)', () => {
    const names = new Set(tables(entityBatch).map((t) => t.name));
    expect(names.has('photos')).toBe(true);
  });

  it('handles irregular plurals (Person → people)', () => {
    const names = new Set(tables(entityBatch).map((t) => t.name));
    expect(names.has('people')).toBe(true);
  });

  it('emits direct-confidence DBIs for static method calls on the Model class', () => {
    const direct = dbis(serviceBatch).filter((d) => d.confidence === 'direct');
    // 7 service functions: listUsers, getUser, createUser, updateUser,
    // destroyUser, countPhotos, listPeople.
    expect(direct.length).toBeGreaterThanOrEqual(7);
  });

  it('routes User.findAll() to the @Table("users") table id', () => {
    const directIds = new Set(
      dbis(serviceBatch).filter((d) => d.confidence === 'direct').map((d) => d.id),
    );
    const targets = new Set(
      serviceBatch.edges
        .filter((e) => e.edgeType === 'READS' || e.edgeType === 'WRITES')
        .filter((e) => directIds.has(e.from))
        .map((e) => e.to),
    );
    expect(targets.has(tableId('users'))).toBe(true);
    expect(targets.has(tableId('photos'))).toBe(true);
    expect(targets.has(tableId('people'))).toBe(true);
  });
});

describe('SequelizePlugin.appliesTo', () => {
  it('activates on `sequelize` dep', () => {
    const plugin = new SequelizePlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: { dependencies: { sequelize: '^6.0.0' } }, files: [] })).toBe(true);
  });
  it('activates on `sequelize-typescript` dep', () => {
    const plugin = new SequelizePlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: { dependencies: { 'sequelize-typescript': '^2.0.0' } }, files: [] })).toBe(true);
  });
  it('does not activate without sequelize deps', () => {
    const plugin = new SequelizePlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: { dependencies: { express: '^4.0.0' } }, files: [] })).toBe(false);
  });
});
