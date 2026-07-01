import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type DatabaseInteraction, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { JavaLanguagePlugin } from '@adorable/lang-java';
import { JpaPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/java/jpa');

async function extract(file: string): Promise<NodeBatch> {
  const jpa = new JpaPlugin();
  const java = new JavaLanguagePlugin();
  java.registerVisitor(jpa.visitor);
  const handle = await java.loadProject({ rootDir: FIXTURE_ROOT });
  return java.extractFile(handle, file);
}

function interactions(batch: { nodes: SchemaNode[] }): DatabaseInteraction[] {
  return batch.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
}

describe('jpa repository method detection', () => {
  it('detects findAll as read operation', async () => {
    const batch = await extract('UserService.java');
    const ints = interactions(batch);
    const reads = ints.filter((i) => i.operation === 'read');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('detects save as write operation', async () => {
    const batch = await extract('UserService.java');
    const ints = interactions(batch);
    const writes = ints.filter((i) => i.operation === 'write');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('detects deleteById as delete operation', async () => {
    const batch = await extract('UserService.java');
    const ints = interactions(batch);
    const deletes = ints.filter((i) => i.operation === 'delete');
    expect(deletes.length).toBeGreaterThan(0);
  });

  it('sets orm="jpa"', async () => {
    const batch = await extract('UserService.java');
    for (const i of interactions(batch)) expect(i.orm).toBe('jpa');
  });

  it('every interaction passes schema validation', async () => {
    const batch = await extract('UserService.java');
    for (const i of interactions(batch)) expect(() => validateNode(i)).not.toThrow();
  });
});

describe('JpaPlugin contract', () => {
  it('has id="jpa" and language="java"', () => {
    const plugin = new JpaPlugin();
    expect(plugin.id).toBe('jpa');
    expect(plugin.language).toBe('java');
  });
});
