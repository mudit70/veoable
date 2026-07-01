import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { WsPyPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/ws-py/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new WsPyPlugin();
  const py = new PyLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'ws-py-fixture',
    files: ['server.py', 'no_imports.py'],
    packageJson: null,
  } as any);
  py.registerVisitor(plugin.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-ws-py visitor', () => {
  it('emits APIEndpoint for websockets.serve(handler, ...) and bare serve(...)', async () => {
    const batch = await extract('server.py');
    // serve_qualified + serve_unqualified = 2
    expect(endpoints(batch).length).toBe(2);
    for (const e of endpoints(batch)) {
      expect(e.httpMethod).toBe('WS');
      expect(e.routePattern).toBe('ws:/');
      expect(e.framework).toBe('ws-py');
    }
  });

  it('emits ClientSideAPICaller for websockets.connect("ws://...")', async () => {
    const batch = await extract('server.py');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('ws://api.example.com/feed');
    expect(urls).toContain('ws://api.example.com/orders');
  });

  it('skips dynamic-URL connect calls', async () => {
    const batch = await extract('server.py');
    // connect_qualified + connect_unqualified = 2; connect_dynamic skipped.
    expect(callers(batch).length).toBe(2);
  });

  it('every client caller carries httpMethod="WS" and emits MAKES_REQUEST', async () => {
    const batch = await extract('server.py');
    for (const c of callers(batch)) {
      expect(c.httpMethod).toBe('WS');
      expect(c.framework).toBe('ws-py');
    }
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no websockets import', async () => {
    const batch = await extract('no_imports.py');
    expect(endpoints(batch)).toEqual([]);
    expect(callers(batch)).toEqual([]);
  });
});
