import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { AmqplibPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/amqplib/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new AmqplibPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-amqplib visitor', () => {
  it('emits one ClientSideAPICaller per producer publish/sendToQueue literal', async () => {
    const batch = await extract('producer.ts');
    // publishOrder, sendToQueueDirect = 2 (dynamicTopic skipped)
    expect(callers(batch).length).toBe(2);
  });

  it('extracts amqp:<exchange>/<routingKey> from publish', async () => {
    const batch = await extract('producer.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('amqp:orders/order.created');
  });

  it('uses amqp:/<queue> for sendToQueue (default exchange)', async () => {
    const batch = await extract('producer.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('amqp:/emails');
  });

  it('every caller carries framework="amqplib" and JOB method', async () => {
    const batch = await extract('producer.ts');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('amqplib');
      expect(c.httpMethod).toBe('JOB');
    }
  });

  it('extracts queue from consumer.consume(...)', async () => {
    const batch = await extract('consumer.ts');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('amqp:/order.created');
    expect(routes).toContain('amqp:/emails');
  });

  it('emits MAKES_REQUEST for every producer caller', async () => {
    const batch = await extract('producer.ts');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no amqplib import', async () => {
    const batch = await extract('no_imports.ts');
    expect(endpoints(batch)).toEqual([]);
    expect(callers(batch)).toEqual([]);
  });
});
