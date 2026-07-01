import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { GrpcioPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/grpcio/basic');

async function extract(file: string): Promise<NodeBatch> {
  const grpcio = new GrpcioPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(grpcio.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-grpcio visitor', () => {
  it('emits one APIEndpoint per method on a Servicer-inheriting class', async () => {
    const batch = await extract('server.py');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    // Greeter:   SayHello, SayGoodbye, ListUsersStream     (3)
    // EchoServer: Echo                                      (1)
    // MultiBase(GreeterServicer, EchoServicer): SayHello
    //   emits TWICE — once per Servicer base                (2)
    // Widget(WidgetServicer): MakeWidget                    (1, __init__ skipped)
    // = 7 total
    expect(patterns).toEqual([
      'grpc:Echo/Echo',
      'grpc:Echo/SayHello',
      'grpc:Greeter/ListUsersStream',
      'grpc:Greeter/SayGoodbye',
      'grpc:Greeter/SayHello',
      'grpc:Greeter/SayHello',
      'grpc:Widget/MakeWidget',
    ]);
  });

  it('marks every endpoint with httpMethod=GRPC + framework=grpcio', async () => {
    const batch = await extract('server.py');
    for (const e of endpoints(batch)) {
      expect(e.httpMethod).toBe('GRPC');
      expect(e.framework).toBe('grpcio');
    }
  });

  it('strips the trailing Servicer suffix from the service name', async () => {
    const batch = await extract('server.py');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    // Every pattern is `grpc:<X>/<method>` where X has no trailing
    // "Servicer". The bare-base case (EchoServicer → Echo) confirms.
    for (const p of patterns) {
      expect(p.startsWith('grpc:')).toBe(true);
      const service = p.slice('grpc:'.length).split('/')[0];
      expect(service.endsWith('Servicer')).toBe(false);
    }
  });

  it('peels the pb2_grpc. scoped prefix off the parent class', async () => {
    const batch = await extract('server.py');
    // The Greeter class inherits from `helloworld_pb2_grpc.GreeterServicer`.
    // Route pattern should still be `grpc:Greeter/...`, not
    // `grpc:helloworld_pb2_grpc.Greeter/...`.
    const greeterEps = endpoints(batch).filter((e) => e.routePattern.startsWith('grpc:Greeter/'));
    expect(greeterEps.length).toBeGreaterThan(0);
  });

  it('does NOT emit for classes that do not inherit from `*Servicer`', async () => {
    const batch = await extract('server.py');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    // HelperUtil and GreeterServicing must not appear.
    for (const p of patterns) {
      expect(p).not.toContain('HelperUtil');
      expect(p).not.toContain('GreeterServicing');
    }
  });

  it('skips dunder methods (`__init__`, etc.)', async () => {
    const batch = await extract('server.py');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).not.toContain('grpc:Widget/__init__');
  });

  it('handles async methods (streaming RPCs)', async () => {
    const batch = await extract('server.py');
    const stream = endpoints(batch).find((e) => e.routePattern === 'grpc:Greeter/ListUsersStream');
    expect(stream).toBeTruthy();
  });

  it('handler-id resolves to the lang-py FunctionDefinition (`<Class>.<method>`)', async () => {
    const batch = await extract('server.py');
    const greeterFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'Greeter.SayHello',
    );
    expect(greeterFn).toBeTruthy();
    const ep = endpoints(batch).find((e) => e.handlerFunctionId === greeterFn!.id);
    expect(ep).toBeTruthy();
    expect(ep!.routePattern).toBe('grpc:Greeter/SayHello');
  });

  it('emits separate APIEndpoints for each `*Servicer` base when a class multi-inherits', async () => {
    const batch = await extract('server.py');
    // MultiBase(GreeterServicer, EchoServicer): SayHello → 2 emits:
    //   grpc:Greeter/SayHello + grpc:Echo/SayHello, both with the
    //   same handlerFunctionId (MultiBase.SayHello).
    const multibaseFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'MultiBase.SayHello',
    );
    expect(multibaseFn).toBeTruthy();
    const eps = endpoints(batch).filter((e) => e.handlerFunctionId === multibaseFn!.id);
    expect(eps.length).toBe(2);
    const routes = eps.map((e) => e.routePattern).sort();
    expect(routes).toEqual(['grpc:Echo/SayHello', 'grpc:Greeter/SayHello']);
  });

  it('attaches SourceEvidence with line numbers', async () => {
    const batch = await extract('server.py');
    for (const e of endpoints(batch)) {
      expect(e.evidence?.filePath).toContain('server.py');
      expect(e.evidence?.lineStart).toBeGreaterThan(0);
    }
  });
});
