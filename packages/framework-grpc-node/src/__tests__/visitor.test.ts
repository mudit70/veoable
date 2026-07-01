import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { GrpcNodePlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/grpc-node/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new GrpcNodePlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-grpc-node visitor', () => {
  it('emits one APIEndpoint per method in addService handler object', async () => {
    const batch = await extract('server.ts');
    // GreeterService: SayHello, SayGoodbye (2)
    // OrdersService: CreateOrder, GetOrder, DeleteOrder (3)
    // = 5
    expect(endpoints(batch).length).toBe(5);
  });

  it('routePattern is grpc:<service>/<method>', async () => {
    const batch = await extract('server.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    expect(patterns).toContain('grpc:Greeter/SayHello');
    expect(patterns).toContain('grpc:Greeter/SayGoodbye');
    expect(patterns).toContain('grpc:Orders/CreateOrder');
    expect(patterns).toContain('grpc:Orders/GetOrder');
    expect(patterns).toContain('grpc:Orders/DeleteOrder');
  });

  it('every endpoint carries httpMethod="GRPC" and framework="grpc-node"', async () => {
    const batch = await extract('server.ts');
    for (const e of endpoints(batch)) {
      expect(e.httpMethod).toBe('GRPC');
      expect(e.framework).toBe('grpc-node');
    }
  });

  it('rejects all emits in a file with no @grpc/grpc-js import', async () => {
    const batch = await extract('no_imports.ts');
    expect(endpoints(batch)).toEqual([]);
  });
});
