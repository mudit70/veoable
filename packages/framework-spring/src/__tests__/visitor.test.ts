import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { JavaLanguagePlugin } from '@veoable/lang-java';
import { SpringPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/java/spring');

async function extract(file: string): Promise<NodeBatch> {
  const spring = new SpringPlugin();
  const java = new JavaLanguagePlugin();
  java.registerVisitor(spring.visitor);
  const handle = await java.loadProject({ rootDir: FIXTURE_ROOT });
  return java.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('spring boot endpoint detection', () => {
  it('detects @GetMapping, @PostMapping, @PutMapping, @DeleteMapping, @PatchMapping', async () => {
    const batch = await extract('UserController.java');
    const eps = endpoints(batch);
    const methods = new Set(eps.map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
  });

  it('composes class-level @RequestMapping prefix with method path', async () => {
    const batch = await extract('UserController.java');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => e.routePattern);
    expect(patterns).toContain('/api/users');
    expect(patterns).toContain('/api/users/{id}');
  });

  it('sets framework="spring"', async () => {
    const batch = await extract('UserController.java');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('spring');
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extract('UserController.java');
    for (const ep of endpoints(batch)) expect(() => validateNode(ep)).not.toThrow();
  });
});

describe('negative cases', () => {
  it('does not detect endpoints on non-annotated classes', async () => {
    const batch = await extract('Negatives.java');
    expect(endpoints(batch)).toHaveLength(0);
  });
});

describe('SpringPlugin contract', () => {
  it('has id="spring" and language="java"', () => {
    const plugin = new SpringPlugin();
    expect(plugin.id).toBe('spring');
    expect(plugin.language).toBe('java');
  });
});

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const spring = new SpringPlugin();
      const java = new JavaLanguagePlugin();
      java.registerVisitor(spring.visitor);
      const handle = await java.loadProject({ rootDir: FIXTURE_ROOT });
      const batch = await java.extractFile(handle, 'UserController.java');
      store.commit(batch, makeBatchMeta('java'));
      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) expect(ep.framework).toBe('spring');
    } finally { store.close(); }
  });
});
