import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { WsTsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/ws-ts/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new WsTsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-ws-ts visitor', () => {
  it('emits APIEndpoint for new WebSocketServer({ port, path })', async () => {
    const batch = await extract('server.ts');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('ws:/api/chat');
  });

  it('emits APIEndpoint with `ws:/` when no path is given', async () => {
    const batch = await extract('server.ts');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('ws:/');
  });

  it('emits APIEndpoint for socket.io new Server(...)', async () => {
    const batch = await extract('server.ts');
    const eps = endpoints(batch);
    // Server ctor + io.on('connection') both fire; both produce
    // `ws:/` route patterns (deduped by id).
    expect(eps.some((e) => e.routePattern === 'ws:/')).toBe(true);
  });

  it('every endpoint carries httpMethod="WS" and framework="ws-ts"', async () => {
    const batch = await extract('server.ts');
    for (const e of endpoints(batch)) {
      expect(e.httpMethod).toBe('WS');
      expect(e.framework).toBe('ws-ts');
    }
  });

  it('emits ClientSideAPICaller for new WebSocket("ws://...")', async () => {
    const batch = await extract('server.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('ws://api.example.com/feed');
  });

  it('client callers carry httpMethod="WS" and emit MAKES_REQUEST', async () => {
    const batch = await extract('server.ts');
    for (const c of callers(batch)) {
      expect(c.httpMethod).toBe('WS');
      expect(c.framework).toBe('ws-ts');
    }
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no ws/socket.io import', async () => {
    const batch = await extract('no_imports.ts');
    expect(endpoints(batch)).toEqual([]);
    expect(callers(batch)).toEqual([]);
  });
});
