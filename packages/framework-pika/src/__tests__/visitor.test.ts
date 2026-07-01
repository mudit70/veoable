import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { PikaPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/pika/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new PikaPlugin();
  const py = new PyLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'pika-fixture',
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

describe('framework-pika visitor', () => {
  it('emits a caller for each basic_publish(exchange,routing_key) literal', async () => {
    const batch = await extract('producer.py');
    expect(callers(batch).length).toBe(2);
  });

  it('extracts amqp:<exchange>/<routing_key>', async () => {
    const batch = await extract('producer.py');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('amqp:orders/order.created');
    expect(urls).toContain('amqp:audit/audit.write');
  });

  it('every producer caller carries framework="pika" and JOB', async () => {
    const batch = await extract('producer.py');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('pika');
      expect(c.httpMethod).toBe('JOB');
    }
  });

  it('extracts queue from basic_consume(queue=...)', async () => {
    const batch = await extract('consumer.py');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('amqp:/order.created');
    expect(routes).toContain('amqp:/audit.write');
  });

  it('rejects all emits in files without pika import', async () => {
    const batch = await extract('no_imports.py');
    expect(callers(batch)).toEqual([]);
    expect(endpoints(batch)).toEqual([]);
  });
});
