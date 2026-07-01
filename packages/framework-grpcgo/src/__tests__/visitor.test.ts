import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { GrpcgoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/grpcgo/basic');

async function extract(file: string): Promise<NodeBatch> {
  const grpcgo = new GrpcgoPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(grpcgo.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-grpcgo visitor', () => {
  it('emits one APIEndpoint per method on a struct that embeds Unimplemented*Server', async () => {
    const batch = await extract('server.go');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    // greeterServer: SayHello, SayGoodbye, ListUsersStream    (3)
    // echoServer:    Echo                                      (1)
    // multiBase(GreeterServer + EchoServer): DualMethod
    //   emits TWICE — once per Servicer embed                  (2)
    // widgetServer:  MakeWidget                                (1, non-pointer receiver)
    // = 7 total. plainStruct + lookalikeServer + anotherLookalike must NOT emit.
    expect(patterns).toEqual([
      'grpc:Echo/DualMethod',
      'grpc:Echo/Echo',
      'grpc:Greeter/DualMethod',
      'grpc:Greeter/ListUsersStream',
      'grpc:Greeter/SayGoodbye',
      'grpc:Greeter/SayHello',
      'grpc:Widget/MakeWidget',
    ]);
  });

  it('marks every endpoint with httpMethod=GRPC + framework=grpcgo', async () => {
    const batch = await extract('server.go');
    for (const e of endpoints(batch)) {
      expect(e.httpMethod).toBe('GRPC');
      expect(e.framework).toBe('grpcgo');
    }
  });

  it('handles scoped embedded servicer (`pb.UnimplementedGreeterServer`)', async () => {
    const batch = await extract('server.go');
    const greeter = endpoints(batch).filter((e) => e.routePattern.startsWith('grpc:Greeter/'));
    // 3 methods on greeterServer + 1 on multiBase (via Greeter embed) = 4.
    expect(greeter.length).toBe(4);
  });

  it('handles bare embedded servicer (`UnimplementedEchoServer`)', async () => {
    const batch = await extract('server.go');
    const echo = endpoints(batch).find((e) => e.routePattern === 'grpc:Echo/Echo');
    expect(echo).toBeTruthy();
  });

  it('does NOT emit for structs without an Unimplemented*Server embed', async () => {
    const batch = await extract('server.go');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    for (const p of patterns) {
      expect(p).not.toContain('plainStruct');
      expect(p).not.toContain('lookalikeServer');
      expect(p).not.toContain('anotherLookalike');
      expect(p).not.toContain('PlainMethod');
      expect(p).not.toContain('NotAnRpc');
      expect(p).not.toContain('AlsoNotAnRpc');
    }
  });

  it('does NOT match `UnimplementedThingy` (no Server suffix)', async () => {
    const batch = await extract('server.go');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns.some((p) => p.startsWith('grpc:Thingy/'))).toBe(false);
  });

  it('does NOT match `GreeterServer` (no Unimplemented prefix)', async () => {
    // This is an existing service-named struct, NOT a generated
    // Unimplemented stub. The visitor must skip it.
    const batch = await extract('server.go');
    const eps = endpoints(batch);
    // 7 expected total — anotherLookalike does NOT contribute.
    expect(eps.length).toBe(7);
  });

  it('emits separate APIEndpoints for each `Unimplemented*Server` embed when a struct multi-embeds', async () => {
    const batch = await extract('server.go');
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'multiBase.DualMethod',
    );
    expect(fn).toBeTruthy();
    const eps = endpoints(batch).filter((e) => e.handlerFunctionId === fn!.id);
    expect(eps.length).toBe(2);
    const routes = eps.map((e) => e.routePattern).sort();
    expect(routes).toEqual(['grpc:Echo/DualMethod', 'grpc:Greeter/DualMethod']);
  });

  it('handles non-pointer receivers (`func (w widgetServer) ...`)', async () => {
    const batch = await extract('server.go');
    const widget = endpoints(batch).find((e) => e.routePattern === 'grpc:Widget/MakeWidget');
    expect(widget).toBeTruthy();
  });

  it('handler-id resolves to the lang-go FunctionDefinition (`<RecvType>.<MethodName>`)', async () => {
    const batch = await extract('server.go');
    const sayHelloFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'greeterServer.SayHello',
    );
    expect(sayHelloFn).toBeTruthy();
    const ep = endpoints(batch).find((e) => e.handlerFunctionId === sayHelloFn!.id);
    expect(ep).toBeTruthy();
    expect(ep!.routePattern).toBe('grpc:Greeter/SayHello');
  });

  it('attaches SourceEvidence with line numbers', async () => {
    const batch = await extract('server.go');
    for (const e of endpoints(batch)) {
      expect(e.evidence?.filePath).toContain('server.go');
      expect(e.evidence?.lineStart).toBeGreaterThan(0);
    }
  });
});
