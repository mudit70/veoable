import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { LapinPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/lapin/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new LapinPlugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'lapin-fixture',
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

describe('framework-lapin visitor', () => {
  it('emits a ClientSideAPICaller per basic_publish with literal exchange + routing_key', async () => {
    const batch = await extract('src/main.rs');
    // publish_order:        ("orders","order.created")  → 1
    // publish_audit:        ("audit","audit.write")     → 1
    // publish_raw_string:   (r"raw-exchange",r"raw.route") → 1
    // publish_dynamic:      (exchange,"order.dynamic") → skipped (partial)
    expect(callers(batch).length).toBe(3);
  });

  it('builds amqp:<exchange>/<routingKey> URLs', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('amqp:orders/order.created');
    expect(urls).toContain('amqp:audit/audit.write');
    expect(urls).toContain('amqp:raw-exchange/raw.route');
  });

  it('skips basic_publish when either arg is dynamic', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    for (const u of urls) {
      expect(u).not.toContain('order.dynamic');
    }
  });

  it('marks every caller framework="lapin" and JOB', async () => {
    const batch = await extract('src/main.rs');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('lapin');
      expect(c.httpMethod).toBe('JOB');
      expect(c.egressConfidence).toBe('exact');
    }
  });

  it('emits an APIEndpoint per basic_consume with a literal queue', async () => {
    const batch = await extract('src/main.rs');
    // consume_orders: "order.created" → 1
    // consume_audit:  "audit.write"   → 1
    // consume_dynamic: queue (ident)   → 0
    expect(endpoints(batch).length).toBe(2);
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('amqp:/order.created');
    expect(routes).toContain('amqp:/audit.write');
  });

  it('marks every endpoint framework="lapin" and JOB', async () => {
    const batch = await extract('src/main.rs');
    for (const e of endpoints(batch)) {
      expect(e.framework).toBe('lapin');
      expect(e.httpMethod).toBe('JOB');
    }
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('src/main.rs');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('attaches handlerFunctionId from the enclosing function', async () => {
    const batch = await extract('src/main.rs');
    for (const e of endpoints(batch)) {
      expect(e.handlerFunctionId).not.toBeNull();
    }
  });

  it('rejects all emits in a file with no lapin use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(callers(batch)).toEqual([]);
    expect(endpoints(batch)).toEqual([]);
  });
});
