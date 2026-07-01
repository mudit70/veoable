import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { KafkapyPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/kafkapy/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new KafkapyPlugin();
  const py = new PyLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'kafkapy-fixture',
    files: ['producer.py', 'consumer.py', 'no_imports.py'],
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

describe('framework-kafkapy visitor', () => {
  it('emits one ClientSideAPICaller per producer call', async () => {
    const batch = await extract('producer.py');
    // kp_send, kp_send_kwarg, ck_produce, aio_send_and_wait,
    //   aio_send_batch = 5 (dynamic_topic skipped)
    expect(callers(batch).length).toBe(5);
  });

  it('covers aiokafka producer verbs (send_and_wait, send_batch)', async () => {
    const batch = await extract('producer.py');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('kafka:async-events');
    expect(urls).toContain('kafka:async-batches');
  });

  it('every producer caller carries framework="kafkapy" and JOB method', async () => {
    const batch = await extract('producer.py');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('kafkapy');
      expect(c.httpMethod).toBe('JOB');
      expect(c.egressConfidence).toBe('exact');
    }
  });

  it('extracts topic from positional, kwarg, and confluent .produce()', async () => {
    const batch = await extract('producer.py');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('kafka:user-events');
    expect(urls).toContain('kafka:order-events');
    expect(urls).toContain('kafka:payments');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('producer.py');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('extracts every topic from `KafkaConsumer("t1", "t2", ...)`', async () => {
    const batch = await extract('consumer.py');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('kafka:user-events');
    expect(routes).toContain('kafka:order-events');
  });

  it('extracts topics from `.subscribe([...])` and `.subscribe(topics=[...])`', async () => {
    const batch = await extract('consumer.py');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('kafka:payments');
    expect(routes).toContain('kafka:notifications');
    expect(routes).toContain('kafka:audit-log');
  });

  it('every consumer endpoint carries framework="kafkapy" and JOB method', async () => {
    const batch = await extract('consumer.py');
    for (const e of endpoints(batch)) {
      expect(e.framework).toBe('kafkapy');
      expect(e.httpMethod).toBe('JOB');
    }
  });

  it('emits one APIEndpoint per declared topic across the consumer file', async () => {
    const batch = await extract('consumer.py');
    // kp_ctor_topics: user-events, order-events (2)
    // kp_subscribe_list: payments (1)
    // kp_subscribe_kwarg: notifications (1)
    // ck_subscribe: audit-log (1)
    // = 5
    expect(endpoints(batch).length).toBe(5);
  });

  it('attaches handlerFunctionId from enclosing function', async () => {
    const batch = await extract('consumer.py');
    for (const e of endpoints(batch)) {
      expect(e.handlerFunctionId).not.toBeNull();
    }
  });

  it('rejects all emits in a file with no kafka import', async () => {
    const batch = await extract('no_imports.py');
    expect(callers(batch)).toEqual([]);
    expect(endpoints(batch)).toEqual([]);
  });
});
