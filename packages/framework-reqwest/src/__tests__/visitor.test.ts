import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { ReqwestPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/reqwest/basic');

async function extract(file: string): Promise<NodeBatch> {
  const reqwest = new ReqwestPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(reqwest.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-reqwest visitor', () => {
  it('emits one ClientSideAPICaller per recognized reqwest call site', async () => {
    const batch = await extract('src/main.rs');
    // Expected (in source order):
    //   top_level_get: reqwest::get(…)              → GET, exact
    //   top_level_blocking_get: reqwest::blocking::get → GET, exact
    //   client.get(literal)                          → GET, exact
    //   client.post(literal)                         → POST, exact
    //   client.put(format!(…))                       → PUT, dynamic
    //   client.delete(&url)                          → DELETE, dynamic
    //   client.patch(literal)                        → PATCH, exact
    //   client.head(literal)                         → HEAD, exact
    //   api.get(literal)                             → GET, exact
    //   http_client.post(literal)                    → POST, exact
    //   self.client.get(literal)                     → GET, exact
    // = 11 total. map.get(...) is rejected by RECEIVER_RE.
    const cs = callers(batch);
    expect(cs.length).toBe(11);
  });

  it('marks every caller with framework=reqwest', async () => {
    const batch = await extract('src/main.rs');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('reqwest');
    }
  });

  it('extracts static URL literals exactly', async () => {
    const batch = await extract('src/main.rs');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    const urls = exact.map((c) => c.urlLiteral).sort();
    // 9 exact calls in main.rs:
    //   reqwest::get("/users")
    //   reqwest::blocking::get("/health")
    //   client.{get("/users"),post("/users"),patch("/users/1"),head("/users")}
    //   api.get("/items"), http_client.post("/items")
    //   self.client.get("/wrapped")
    expect(urls).toEqual([
      'https://api.example.com/health',
      'https://api.example.com/items',
      'https://api.example.com/items',
      'https://api.example.com/users',
      'https://api.example.com/users',
      'https://api.example.com/users',
      'https://api.example.com/users',
      'https://api.example.com/users/1',
      'https://api.example.com/wrapped',
    ]);
  });

  it('marks dynamic URLs (format! and &url) with egressConfidence=dynamic', async () => {
    const batch = await extract('src/main.rs');
    const dynamic = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    expect(dynamic.length).toBe(2);
    for (const c of dynamic) expect(c.urlLiteral).toBeNull();
    // The two dynamic calls are the PUT (format!) and DELETE (&url).
    expect(dynamic.map((c) => c.httpMethod).sort()).toEqual(['DELETE', 'PUT']);
  });

  it('records the HTTP verb per call', async () => {
    const batch = await extract('src/main.rs');
    const verbs = callers(batch).map((c) => c.httpMethod).sort();
    expect(verbs).toEqual(['DELETE', 'GET', 'GET', 'GET', 'GET', 'GET', 'HEAD', 'PATCH', 'POST', 'POST', 'PUT']);
  });

  it('emits MAKES_REQUEST edges from the enclosing function to the caller', async () => {
    const batch = await extract('src/main.rs');
    const callerIds = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(callerIds.size);
    for (const e of edges) {
      expect(callerIds.has(e.to)).toBe(true);
    }
  });

  it('does NOT emit for `<map>.get(key)` style unrelated method calls', async () => {
    const batch = await extract('src/main.rs');
    // The fixture's `unrelated_get_must_not_emit` function calls
    // `map.get("foo")`. RECEIVER_RE requires the receiver to contain
    // client/http/api/reqwest. `map` matches none, so no emit.
    expect(callers(batch).some((c) => c.urlLiteral === 'foo')).toBe(false);
  });

  it('does NOT emit for a file with no `use reqwest::*` import', async () => {
    // no_reqwest.rs has a `client.get(literal)` but no reqwest
    // import. The per-file gate (`hasCrateImport`) must keep us out.
    const batch = await extract('src/no_reqwest.rs');
    expect(callers(batch)).toEqual([]);
  });

  it('extracts blocking::get as GET with exact URL', async () => {
    const batch = await extract('src/main.rs');
    const blocking = callers(batch).find((c) => c.urlLiteral === 'https://api.example.com/health');
    expect(blocking).toBeTruthy();
    expect(blocking!.httpMethod).toBe('GET');
    expect(blocking!.egressConfidence).toBe('exact');
  });

  it('marks public-host URLs as external and records the host', async () => {
    const batch = await extract('src/main.rs');
    // Every literal URL in the fixture is `https://api.example.com/...`.
    const exactExternal = callers(batch).filter((c) => c.egressConfidence === 'exact');
    expect(exactExternal.length).toBeGreaterThan(0);
    for (const c of exactExternal) {
      expect(c.isExternal).toBe(true);
      expect(c.externalHost).toBe('api.example.com');
    }
    // Dynamic URLs don't get isExternal at all.
    const dynamic = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    for (const c of dynamic) {
      expect(c.isExternal).toBeUndefined();
    }
  });
});
