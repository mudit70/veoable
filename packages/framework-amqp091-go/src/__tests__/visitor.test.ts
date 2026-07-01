import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { Amqp091GoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/amqp091-go/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new Amqp091GoPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-amqp091-go visitor', () => {
  it('emits a caller for PublishWithContext + Publish literals', async () => {
    const batch = await extract('svc.go');
    expect(callers(batch).length).toBe(2);
  });

  it('extracts amqp:<exchange>/<routingKey>', async () => {
    const batch = await extract('svc.go');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('amqp:orders/order.created');
    expect(urls).toContain('amqp:audit/audit.write');
  });

  it('every caller carries framework="amqp091-go" and JOB', async () => {
    const batch = await extract('svc.go');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('amqp091-go');
      expect(c.httpMethod).toBe('JOB');
    }
  });

  it('extracts queue from Consume and ConsumeWithContext', async () => {
    const batch = await extract('svc.go');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('amqp:/order.created');
    expect(routes).toContain('amqp:/audit.write');
  });

  it('rejects all emits in files without amqp091/streadway import', async () => {
    const batch = await extract('no_imports.go');
    expect(callers(batch)).toEqual([]);
    expect(endpoints(batch)).toEqual([]);
  });
});
