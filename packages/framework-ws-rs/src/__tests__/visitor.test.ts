import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { WsRsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/ws-rs/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new WsRsPlugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'ws-rs-fixture',
    files: ['src/main.rs', 'src/no_imports.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(plugin.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-ws-rs visitor', () => {
  it('emits APIEndpoint for accept_async(stream)', async () => {
    const batch = await extract('src/main.rs');
    // handle_socket + handle_scoped = 2 server endpoints
    expect(endpoints(batch).length).toBe(2);
    for (const e of endpoints(batch)) {
      expect(e.httpMethod).toBe('WS');
      expect(e.routePattern).toBe('ws:/');
      expect(e.framework).toBe('ws-rs');
    }
  });

  it('emits ClientSideAPICaller for connect_async("ws://...") and "wss://"', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('ws://api.example.com/feed');
    expect(urls).toContain('wss://secure.example.com/orders');
  });

  it('skips dynamic-URL connect_async calls', async () => {
    const batch = await extract('src/main.rs');
    // dial_feed + dial_secure = 2; dial_dynamic skipped.
    expect(callers(batch).length).toBe(2);
  });

  it('emits MAKES_REQUEST for every client caller', async () => {
    const batch = await extract('src/main.rs');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no tungstenite use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(endpoints(batch)).toEqual([]);
    expect(callers(batch)).toEqual([]);
  });
});
