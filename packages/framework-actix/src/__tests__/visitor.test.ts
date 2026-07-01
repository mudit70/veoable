import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { ActixPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/rust/actix');

async function extract(file: string): Promise<NodeBatch> {
  const actix = new ActixPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(actix.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('actix-web attribute macro detection', () => {
  it('detects all HTTP verb attributes', async () => {
    const batch = await extract('server.rs');
    const eps = endpoints(batch);
    const methods = new Set(eps.map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
  });

  it('captures route patterns', async () => {
    const batch = await extract('server.rs');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).toContain('/users');
    expect(patterns).toContain('/users/:id');
  });

  it('normalizes {param} to :param', async () => {
    const batch = await extract('server.rs');
    for (const ep of endpoints(batch)) {
      expect(ep.routePattern).not.toMatch(/\{/);
    }
  });

  it('sets framework="actix"', async () => {
    const batch = await extract('server.rs');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('actix');
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extract('server.rs');
    for (const ep of endpoints(batch)) expect(() => validateNode(ep)).not.toThrow();
  });
});

describe('negative cases', () => {
  it('does not match non-HTTP attributes', async () => {
    const batch = await extract('negatives.rs');
    expect(endpoints(batch)).toHaveLength(0);
  });
});

describe('Actix scope prefix composition (#204)', () => {
  it('composes web::scope("/api") + service(<fn>)', async () => {
    const batch = await extract('scoped.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    // health is service'd directly into web::scope("/api") with #[get("/health")]
    expect(patterns).toContain('GET /api/health');
  });

  it('composes nested scopes: scope("/api").service(scope("/users").service(<fn>))', async () => {
    const batch = await extract('scoped.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    // list_users has #[get("/")] inside scope("/api")/scope("/users")
    expect(patterns).toContain('GET /api/users/');
    expect(patterns).toContain('POST /api/users/');
    expect(patterns).toContain('GET /api/users/:id');
  });

  it('functions registered directly on App (no scope) are NOT prefixed', async () => {
    const batch = await extract('scoped.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    // list_root is .service'd onto App.new() directly with #[get("/")]
    expect(patterns).toContain('GET /');
  });

  it('un-scoped fixture still emits unprefixed routes', async () => {
    const batch = await extract('server.rs');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    for (const p of patterns) expect(p).not.toMatch(/^\/api\b/);
  });
});

describe('ActixPlugin contract', () => {
  it('has id="actix" and language="rust"', () => {
    const plugin = new ActixPlugin();
    expect(plugin.id).toBe('actix');
    expect(plugin.language).toBe('rust');
  });
});

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const actix = new ActixPlugin();
      const rust = new RustLanguagePlugin();
      rust.registerVisitor(actix.visitor);
      const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
      const batch = await rust.extractFile(handle, 'server.rs');
      store.commit(batch, makeBatchMeta('rust'));
      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
    } finally { store.close(); }
  });
});
