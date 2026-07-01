import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { KafkajsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/kafkajs/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new KafkajsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-kafkajs visitor', () => {
  it('emits one ClientSideAPICaller per producer.send({ topic }) literal', async () => {
    const batch = await extract('producer.ts');
    // sendOne → user-events
    // sendOrders → orders
    // sendBatchMulti → payments, audit-log (2)
    // dynamicTopic → skipped
    // = 4 callers
    expect(callers(batch).length).toBe(4);
  });

  it('extracts topic from .send({ topic }) and .sendBatch({ topicMessages })', async () => {
    const batch = await extract('producer.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('kafka:user-events');
    expect(urls).toContain('kafka:orders');
    expect(urls).toContain('kafka:payments');
    expect(urls).toContain('kafka:audit-log');
  });

  it('every producer caller carries framework="kafkajs" and JOB method', async () => {
    const batch = await extract('producer.ts');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('kafkajs');
      expect(c.httpMethod).toBe('JOB');
      expect(c.egressConfidence).toBe('exact');
    }
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('producer.ts');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('extracts single topic from consumer.subscribe({ topic })', async () => {
    const batch = await extract('consumer.ts');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('kafka:user-events');
  });

  it('extracts list of topics from consumer.subscribe({ topics: [...] })', async () => {
    const batch = await extract('consumer.ts');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('kafka:payments');
    expect(routes).toContain('kafka:notifications');
  });

  it('emits one APIEndpoint per literal topic in consumer.ts', async () => {
    const batch = await extract('consumer.ts');
    // subscribeSingle: user-events (1)
    // subscribeMany: payments, notifications (2)
    // subscribeDynamic: skipped
    expect(endpoints(batch).length).toBe(3);
  });

  it('every consumer endpoint carries framework="kafkajs" and JOB method', async () => {
    const batch = await extract('consumer.ts');
    for (const e of endpoints(batch)) {
      expect(e.framework).toBe('kafkajs');
      expect(e.httpMethod).toBe('JOB');
    }
  });

  it('rejects all emits in a file with no kafkajs import', async () => {
    const batch = await extract('no_imports.ts');
    expect(callers(batch)).toEqual([]);
    expect(endpoints(batch)).toEqual([]);
  });
});
