import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { WsGoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/ws-go/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new WsGoPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-ws-go visitor', () => {
  it('emits APIEndpoint for gorilla upgrader.Upgrade(...)', async () => {
    const batch = await extract('gorilla.go');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThanOrEqual(1);
    for (const e of eps) {
      expect(e.httpMethod).toBe('WS');
      expect(e.routePattern).toBe('ws:/');
      expect(e.framework).toBe('ws-go');
    }
  });

  it('emits ClientSideAPICaller for gorilla DefaultDialer.Dial("ws://...")', async () => {
    const batch = await extract('gorilla.go');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('ws://api.example.com/feed');
  });

  it('skips dynamic-URL Dial calls', async () => {
    const batch = await extract('gorilla.go');
    // dialServer emits, dialDynamic skipped → exactly 1.
    expect(callers(batch).length).toBe(1);
  });

  it('emits APIEndpoint for nhooyr websocket.Accept(...)', async () => {
    const batch = await extract('nhooyr.go');
    expect(endpoints(batch).length).toBeGreaterThanOrEqual(1);
  });

  it('emits ClientSideAPICaller for nhooyr websocket.Dial(ctx, "wss://...", ...)', async () => {
    const batch = await extract('nhooyr.go');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('wss://stream.example.com/v1');
  });

  it('emits MAKES_REQUEST for every client caller', async () => {
    const batch = await extract('gorilla.go');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no websocket import', async () => {
    const batch = await extract('no_imports.go');
    expect(endpoints(batch)).toEqual([]);
    expect(callers(batch)).toEqual([]);
  });
});
