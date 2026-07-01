import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { HttpxPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/httpx/basic');

async function extract(file: string): Promise<NodeBatch> {
  const httpx = new HttpxPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(httpx.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-httpx visitor', () => {
  it('emits one ClientSideAPICaller per recognized call site (main.py)', async () => {
    const batch = await extract('main.py');
    const cs = callers(batch);
    // Expected emits in main.py:
    //   1   httpx.get          → top_level_httpx_get
    //   1   client.post        → top_level_httpx_post_async (AsyncClient)
    //   6   client.{get,post,put,delete,patch,head} in httpx_client_methods
    //   3   requests.{get,post,delete} in requests_top_level
    //   2   session.{get,post} in requests_session_methods
    //   1   requests.get(f"...")   → dynamic_url_fstring
    //   1   httpx.get("..." "...") → adjacent_string_concat
    //   1   requests.get(url=...) → kwarg_url_only (url= fallback)
    //   1   self.session.get   → ApiWrapper.fetch
    // = 17 total. data.get(...) and os.environ.get(...) are rejected.
    expect(cs.length).toBe(17);
  });

  it('attributes httpx vs requests correctly per file imports', async () => {
    const batch = await extract('main.py');
    const cs = callers(batch);
    const httpxCount = cs.filter((c) => c.framework === 'httpx').length;
    const requestsCount = cs.filter((c) => c.framework === 'requests').length;
    expect(httpxCount + requestsCount).toBe(cs.length);
    // Attribution breakdown (both `httpx` and `requests` are
    // imported, so the bare-method-chain shape prefers `httpx`):
    //   httpx (12):
    //     - httpx.get(...)                    (top-level identifier)
    //     - AsyncClient.post via `client`     (receiver heuristic, prefer httpx)
    //     - httpx.Client.{6 methods}          (receiver heuristic, prefer httpx)
    //     - requests.Session.{2 methods}      (receiver heuristic on `session` — prefer httpx)
    //     - adjacent_string_concat httpx.get  (top-level identifier)
    //     - self.session.get                  (receiver heuristic — prefer httpx)
    //   requests (5):
    //     - requests.{get,post,delete}        (3 top-level identifiers)
    //     - requests.get(f"...")              (top-level identifier)
    //     - requests.get(url=...)             (top-level identifier, url= kwarg fallback)
    expect(httpxCount).toBe(12);
    expect(requestsCount).toBe(5);
  });

  it('extracts static URL literals', async () => {
    const batch = await extract('main.py');
    const exactUrls = callers(batch)
      .filter((c) => c.egressConfidence === 'exact')
      .map((c) => c.urlLiteral)
      .sort();
    // The f-string call is the only dynamic one. Adjacent concat
    // resolves to exact "https://api.example.com/concat/path".
    expect(exactUrls).toContain('https://api.example.com/users');
    expect(exactUrls).toContain('https://api.example.com/concat/path');
    expect(exactUrls).toContain('https://api.example.com/items');
    expect(exactUrls).toContain('https://api.example.com/things');
    expect(exactUrls).toContain('https://api.example.com/wrapped');
  });

  it('marks f-string URL as dynamic', async () => {
    const batch = await extract('main.py');
    const dynamic = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    expect(dynamic.length).toBe(1);
    expect(dynamic[0].urlLiteral).toBeNull();
    expect(dynamic[0].httpMethod).toBe('GET');
  });

  it('records each HTTP verb', async () => {
    const batch = await extract('main.py');
    const verbs = callers(batch).map((c) => c.httpMethod);
    expect(verbs).toContain('GET');
    expect(verbs).toContain('POST');
    expect(verbs).toContain('PUT');
    expect(verbs).toContain('DELETE');
    expect(verbs).toContain('PATCH');
    expect(verbs).toContain('HEAD');
  });

  it('emits MAKES_REQUEST edges from the enclosing function to the caller', async () => {
    const batch = await extract('main.py');
    const callerIds = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(callerIds.size);
    for (const e of edges) expect(callerIds.has(e.to)).toBe(true);
  });

  it('rejects unrelated `data.get(key)` and `os.environ.get(...)`', async () => {
    const batch = await extract('main.py');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).not.toContain('foo');
    expect(urls).not.toContain('PATH');
  });

  it('rejects all calls in a file with no httpx/requests imports', async () => {
    const batch = await extract('no_imports.py');
    expect(callers(batch)).toEqual([]);
  });

  it('handles adjacent string concatenation as exact', async () => {
    const batch = await extract('main.py');
    const concat = callers(batch).find(
      (c) => c.urlLiteral === 'https://api.example.com/concat/path',
    );
    expect(concat).toBeTruthy();
    expect(concat!.egressConfidence).toBe('exact');
  });

  it('marks public-host URLs as external and records the host', async () => {
    const batch = await extract('main.py');
    const exactExternal = callers(batch).filter((c) => c.egressConfidence === 'exact');
    expect(exactExternal.length).toBeGreaterThan(0);
    for (const c of exactExternal) {
      expect(c.isExternal).toBe(true);
      expect(c.externalHost).toBe('api.example.com');
    }
    const dynamic = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    for (const c of dynamic) {
      expect(c.isExternal).toBeUndefined();
    }
  });

  it('falls back to the `url=` keyword arg when no positional URL is provided', async () => {
    const batch = await extract('main.py');
    const kwarg = callers(batch).find((c) => c.urlLiteral === 'https://api.example.com/kwarg');
    expect(kwarg).toBeTruthy();
    expect(kwarg!.httpMethod).toBe('GET');
    expect(kwarg!.egressConfidence).toBe('exact');
    expect(kwarg!.framework).toBe('requests');
  });

  it('handles AsyncClient method calls', async () => {
    const batch = await extract('main.py');
    // top_level_httpx_post_async emits via `client.post(...)` inside
    // `async with httpx.AsyncClient() as client`. Receiver name is
    // `client` → matches RECEIVER_RE.
    const asyncPost = callers(batch).find(
      (c) => c.httpMethod === 'POST' && c.urlLiteral === 'https://api.example.com/users',
    );
    expect(asyncPost).toBeTruthy();
  });
});
