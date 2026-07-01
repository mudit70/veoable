import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { KafkarsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/kafkars/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new KafkarsPlugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'kafkars-fixture',
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

describe('framework-kafkars visitor', () => {
  it('emits one ClientSideAPICaller per FutureRecord::to / BaseRecord::to literal', async () => {
    const batch = await extract('src/main.rs');
    // send_future:           FutureRecord::to("user-events") (1)
    // send_base:             BaseRecord::to("order-events")  (1)
    // send_dynamic:          dynamic → skipped
    // send_raw_string:       FutureRecord::to(r"raw-events") (1)
    // send_fully_qualified:  rdkafka::producer::FutureRecord::to("fq-events") (1)
    // = 4
    expect(callers(batch).length).toBe(4);
  });

  it('extracts the topic literal from both producer call shapes', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('kafka:user-events');
    expect(urls).toContain('kafka:order-events');
  });

  it('handles raw-string topics: FutureRecord::to(r"...")', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('kafka:raw-events');
  });

  it('handles fully-qualified path: rdkafka::producer::FutureRecord::to("...")', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('kafka:fq-events');
  });

  it('marks every producer caller framework="kafkars" and JOB', async () => {
    const batch = await extract('src/main.rs');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('kafkars');
      expect(c.httpMethod).toBe('JOB');
      expect(c.egressConfidence).toBe('exact');
    }
  });

  it('emits an APIEndpoint per topic in `consumer.subscribe(&["t1", "t2"])`', async () => {
    const batch = await extract('src/main.rs');
    // subscribe_to:    2 topics
    // subscribe_single: 1 topic
    // subscribe_dynamic: array of identifiers → 0 (no string literals)
    // = 3
    expect(endpoints(batch).length).toBe(3);
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('kafka:user-events');
    expect(routes).toContain('kafka:order-events');
    expect(routes).toContain('kafka:audit-log');
  });

  it('marks every consumer endpoint framework="kafkars" and JOB', async () => {
    const batch = await extract('src/main.rs');
    for (const e of endpoints(batch)) {
      expect(e.framework).toBe('kafkars');
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

  it('rejects all emits in a file with no rdkafka use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(callers(batch)).toEqual([]);
    expect(endpoints(batch)).toEqual([]);
  });
});
