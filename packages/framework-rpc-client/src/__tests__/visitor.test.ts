import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClientSideAPICaller } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { RpcClientPlugin } from '../rpc-client-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/rpc-client');
const fixturePath = (s: string) => path.join(FIXTURE_ROOT, s);

async function extractAll(scenario: string, files: string[]): Promise<NodeBatch[]> {
  const plugin = new RpcClientPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  const batches: NodeBatch[] = [];
  for (const f of files) batches.push(await ts.extractFile(handle, f));
  return batches;
}

function callers(b: NodeBatch): ClientSideAPICaller[] {
  return b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');
}

describe('RPC client visitor (#408)', () => {
  let batches: NodeBatch[];
  beforeAll(async () => {
    batches = await extractAll('post-api', ['src/clients.ts', 'src/api.ts', 'src/consumer.ts']);
  });

  it('detects class-field-initialiser shape (this.jade.sendRequest)', () => {
    // api.ts has 3 sendRequest calls on this.jade.
    const apiBatch = batches[1];
    const apiCallers = callers(apiBatch);
    expect(apiCallers.length).toBe(3);
    expect(apiCallers.every((c) => c.framework === 'rpc-client')).toBe(true);
    expect(apiCallers.every((c) => c.httpMethod === 'POST')).toBe(true);
    expect(apiCallers.every((c) => c.egressConfidence === 'exact')).toBe(true);
  });

  it('synthesises URL as `<baseUrl>?r=<methodName>`', () => {
    const apiCallers = callers(batches[1]);
    const urls = new Set(apiCallers.map((c) => c.urlLiteral));
    expect(urls.has('/api/jade?r=GenerateBundle')).toBe(true);
    expect(urls.has('/api/jade?r=GetBundle')).toBe(true);
    expect(urls.has('/api/jade?r=GetVersions')).toBe(true);
  });

  it('detects plain-identifier shape (const client = new PostAPIClient(...))', () => {
    // consumer.ts has 1 listUsers call.
    const consumerCallers = callers(batches[2]);
    const listUsersCaller = consumerCallers.find((c) => c.urlLiteral === '/api/admin?r=ListUsers');
    expect(listUsersCaller).toBeDefined();
    expect(listUsersCaller!.httpMethod).toBe('POST');
  });

  it('detects nested chain (this.api.jade.sendRequest)', () => {
    // consumer.ts Page.loadVersions calls this.api.jade.sendRequest.
    const consumerCallers = callers(batches[2]);
    const nestedCaller = consumerCallers.find((c) => c.urlLiteral === '/api/jade?r=GetVersions');
    expect(nestedCaller).toBeDefined();
  });

  it('emits MAKES_REQUEST edges from enclosing function to caller', () => {
    const apiBatch = batches[1];
    const makesEdges = apiBatch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    const apiCallers = callers(apiBatch);
    expect(makesEdges.length).toBe(apiCallers.length);
  });
});

describe('RpcClientPlugin.appliesTo', () => {
  it('always returns true (like framework-fetch)', () => {
    const plugin = new RpcClientPlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: null, files: [] })).toBe(true);
  });
});

describe('RPC client false-positive guards', () => {
  it('does NOT match sendRequest on a non-allowlisted class', async () => {
    // not-rpc.ts has a `HttpHelper` class that exposes the SAME
    // sendRequest('Method', payload) shape. The constructor name
    // (HttpHelper) is NOT in RPC_CLIENT_CTORS, so the visitor must
    // emit zero callers — a real semantic test, not just file
    // absence.
    const [_clients, _api, _consumer, notRpcBatch] = await extractAll('post-api', [
      'src/clients.ts',
      'src/api.ts',
      'src/consumer.ts',
      'src/not-rpc.ts',
    ]);
    void _clients;
    void _api;
    void _consumer;
    expect(callers(notRpcBatch).length).toBe(0);
  });

  it('emits nothing when a file has no sendRequest calls at all', async () => {
    // clients.ts only DEFINES PostAPIClient; no consumer here.
    const [clientsBatch] = await extractAll('post-api', ['src/clients.ts']);
    expect(callers(clientsBatch).length).toBe(0);
  });
});
