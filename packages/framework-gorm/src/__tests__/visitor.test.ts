import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type DatabaseInteraction, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { GormPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/go/gorm');

async function extract(file: string): Promise<NodeBatch> {
  const gorm = new GormPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(gorm.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

function interactions(batch: { nodes: SchemaNode[] }): DatabaseInteraction[] {
  return batch.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
}

describe('gorm database interaction detection', () => {
  it('detects db.Find as read', async () => {
    const batch = await extract('server.go');
    const reads = interactions(batch).filter((i) => i.operation === 'read');
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('detects db.Create as write', async () => {
    const batch = await extract('server.go');
    const writes = interactions(batch).filter((i) => i.operation === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it('detects db.Delete as delete', async () => {
    const batch = await extract('server.go');
    const deletes = interactions(batch).filter((i) => i.operation === 'delete');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it('detects db.Raw as raw', async () => {
    const batch = await extract('server.go');
    const raws = interactions(batch).filter((i) => i.operation === 'raw');
    expect(raws.length).toBeGreaterThanOrEqual(1);
  });

  it('detects db.Where().Find() chain as read', async () => {
    const batch = await extract('server.go');
    const reads = interactions(batch).filter((i) => i.operation === 'read');
    expect(reads.length).toBeGreaterThanOrEqual(3); // Find, First, Where().Find()
  });

  it('sets orm="gorm"', async () => {
    const batch = await extract('server.go');
    for (const i of interactions(batch)) expect(i.orm).toBe('gorm');
  });

  it('every interaction passes schema validation', async () => {
    const batch = await extract('server.go');
    for (const i of interactions(batch)) expect(() => validateNode(i)).not.toThrow();
  });
});

describe('GormPlugin contract', () => {
  it('has id="gorm" and language="go"', () => {
    const plugin = new GormPlugin();
    expect(plugin.id).toBe('gorm');
    expect(plugin.language).toBe('go');
  });
});
