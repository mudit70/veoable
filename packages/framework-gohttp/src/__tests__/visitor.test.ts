import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type ClientSideAPICaller, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { GoHttpPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_BASE = path.resolve(__dirname, '../../../../tests/fixtures/go');

async function extractFrom(fixtureDir: string, file: string): Promise<NodeBatch> {
  const gohttp = new GoHttpPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(gohttp.visitor);
  const handle = await go.loadProject({ rootDir: path.join(FIXTURES_BASE, fixtureDir) });
  return go.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

function callers(batch: { nodes: SchemaNode[] }): ClientSideAPICaller[] {
  return batch.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');
}

// ──────────────────────────────────────────────────────────────────────
// net/http
// ──────────────────────────────────────────────────────────────────────

describe('net/http route detection', () => {
  it('detects Go 1.22+ method-prefixed patterns', async () => {
    const batch = await extractFrom('nethttp', 'server.go');
    const eps = endpoints(batch);
    const getUsers = eps.find((e) => e.httpMethod === 'GET' && e.routePattern === '/users');
    expect(getUsers).toBeDefined();
    expect(getUsers!.framework).toBe('gohttp');
  });

  it('detects dynamic segments with {param} → :param normalization', async () => {
    const batch = await extractFrom('nethttp', 'server.go');
    const eps = endpoints(batch);
    const getById = eps.find((e) => e.routePattern === '/users/:id');
    expect(getById).toBeDefined();
    expect(getById!.httpMethod).toBe('GET');
  });

  it('detects legacy patterns without method prefix as ALL', async () => {
    const batch = await extractFrom('nethttp', 'server.go');
    const eps = endpoints(batch);
    const health = eps.find((e) => e.routePattern === '/health');
    expect(health).toBeDefined();
    expect(health!.httpMethod).toBe('ALL');
  });

  it('detects package-level http.HandleFunc calls', async () => {
    const batch = await extractFrom('nethttp', 'server.go');
    const eps = endpoints(batch);
    const deleteItems = eps.find((e) => e.routePattern === '/items/:id');
    expect(deleteItems).toBeDefined();
    expect(deleteItems!.httpMethod).toBe('DELETE');
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extractFrom('nethttp', 'server.go');
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Echo (m4 fix)
// ──────────────────────────────────────────────────────────────────────

describe('Echo route detection', () => {
  it('detects Echo e.GET/POST/DELETE routes', async () => {
    const batch = await extractFrom('echo', 'server.go');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThanOrEqual(4);

    const methods = new Set(eps.map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
  });

  it('sets framework="echo"', async () => {
    const batch = await extractFrom('echo', 'server.go');
    for (const ep of endpoints(batch)) {
      expect(ep.framework).toBe('echo');
    }
  });

  it('captures route patterns with :param', async () => {
    const batch = await extractFrom('echo', 'server.go');
    const eps = endpoints(batch);
    expect(eps.map((e) => e.routePattern)).toContain('/users/:id');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Fiber (m4 fix)
// ──────────────────────────────────────────────────────────────────────

describe('Fiber route detection', () => {
  it('detects Fiber app.Get/Post/Delete routes', async () => {
    const batch = await extractFrom('fiber', 'server.go');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThanOrEqual(4);

    const methods = new Set(eps.map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
  });

  it('sets framework="fiber"', async () => {
    const batch = await extractFrom('fiber', 'server.go');
    for (const ep of endpoints(batch)) {
      expect(ep.framework).toBe('fiber');
    }
  });

  it('uppercases HTTP methods from titlecase', async () => {
    const batch = await extractFrom('fiber', 'server.go');
    for (const ep of endpoints(batch)) {
      expect(ep.httpMethod).toBe(ep.httpMethod.toUpperCase());
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('GoHttpPlugin contract', () => {
  it('has id="gohttp" and language="go"', () => {
    const plugin = new GoHttpPlugin();
    expect(plugin.id).toBe('gohttp');
    expect(plugin.language).toBe('go');
  });
});

// ──────────────────────────────────────────────────────────────────────
// net/http client-side (outbound HTTP)
// ──────────────────────────────────────────────────────────────────────

describe('net/http client-side outbound detection', () => {
  it('emits ClientSideAPICaller for http.Get / Post / Head / PostForm', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    const cs = callers(batch);
    const topLevel = cs.filter((c) =>
      ['https://api.example.com/users', 'https://api.example.com/login'].includes(c.urlLiteral ?? ''),
    );
    // Get, Post, Head all target /users; PostForm targets /login = 4 emits.
    expect(topLevel.length).toBe(4);
    const verbs = topLevel.map((c) => c.httpMethod).sort();
    expect(verbs).toEqual(['GET', 'HEAD', 'POST', 'POST']);
  });

  it('extracts METHOD + URL from http.NewRequest("METHOD", URL, body)', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    const cs = callers(batch);
    const put = cs.find((c) => c.httpMethod === 'PUT');
    const del = cs.find((c) => c.httpMethod === 'DELETE');
    expect(put).toBeTruthy();
    expect(put!.urlLiteral).toBe('https://api.example.com/users/1');
    expect(del).toBeTruthy();
    expect(del!.urlLiteral).toBe('https://api.example.com/users/1');
  });

  it('extracts METHOD + URL from http.NewRequestWithContext(ctx, "METHOD", URL, body)', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    const patch = callers(batch).find((c) => c.httpMethod === 'PATCH');
    expect(patch).toBeTruthy();
    expect(patch!.urlLiteral).toBe('https://api.example.com/users/1');
  });

  it('emits for `<client>.{Get,Post,Head,PostForm}` method chain', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    const chain = callers(batch).filter((c) =>
      ['https://api.example.com/items', 'https://api.example.com/form'].includes(c.urlLiteral ?? ''),
    );
    expect(chain.length).toBe(4);
  });

  it('matches `httpClient` receiver via the client-name heuristic', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    const apiClient = callers(batch).find((c) => c.urlLiteral === 'https://api.example.com/api-client');
    expect(apiClient).toBeTruthy();
    expect(apiClient!.httpMethod).toBe('GET');
  });

  it('marks dynamic URLs as egressConfidence=dynamic with urlLiteral=null', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    const dyn = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    expect(dyn.length).toBe(1);
    expect(dyn[0].urlLiteral).toBeNull();
    expect(dyn[0].httpMethod).toBe('GET');
  });

  it('marks public-host URLs as external with externalHost', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    expect(exact.length).toBeGreaterThan(0);
    for (const c of exact) {
      expect(c.isExternal).toBe(true);
      expect(c.externalHost).toBe('api.example.com');
    }
  });

  it('emits MAKES_REQUEST edges from enclosing function to caller', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    const ids = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(ids.size);
    for (const e of edges) expect(ids.has(e.to)).toBe(true);
  });

  it('marks every caller with framework="gohttp"', async () => {
    const batch = await extractFrom('nethttp-client', 'client.go');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('gohttp');
    }
  });

  it('does NOT emit for `<bucket>.Get(...)` (receiver name does not match heuristic)', async () => {
    // Fixture's `bucket` type has a `Get(key string)` method whose
    // first arg HAPPENS to be a literal URL. RECEIVER_RE rejects
    // `b` as a non-client receiver, so the call must be silently
    // skipped even though the file imports net/http.
    const batch = await extractFrom('nethttp-client', 'client.go');
    const sentinel = callers(batch).find(
      (c) => c.urlLiteral === 'https://api.example.com/should-not-emit',
    );
    expect(sentinel).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const gohttp = new GoHttpPlugin();
      const go = new GoLanguagePlugin();
      go.registerVisitor(gohttp.visitor);
      const handle = await go.loadProject({ rootDir: path.join(FIXTURES_BASE, 'nethttp') });

      const batch = await go.extractFile(handle, 'server.go');
      store.commit(batch, makeBatchMeta('go'));

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
