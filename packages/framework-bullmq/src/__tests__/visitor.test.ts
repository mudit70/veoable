import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type APIEndpoint,
  type ClientSideAPICaller,
  type SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { BullmqPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/bullmq/basic');

async function extract(file: string): Promise<NodeBatch> {
  const bullmq = new BullmqPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(bullmq.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}
function callers(batch: { nodes: SchemaNode[] }): ClientSideAPICaller[] {
  return batch.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');
}

describe('BullMQ Worker → APIEndpoint', () => {
  it('emits APIEndpoint per `new Worker(<queue>, handler)` declaration', async () => {
    const batch = await extract('src/worker.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBe(2);
    const patterns = eps.map((e) => e.routePattern).sort();
    expect(patterns).toEqual(['bullmq:emails', 'bullmq:uploads']);
    for (const ep of eps) {
      expect(ep.httpMethod).toBe('JOB');
      expect(ep.framework).toBe('bullmq');
      expect(ep.handlerFunctionId).toBeNull();  // inline arrow handlers don't yet resolve to a FunctionDefinition.
    }
  });

  it('emitted endpoints pass schema validation', async () => {
    const batch = await extract('src/worker.ts');
    for (const ep of endpoints(batch)) expect(() => validateNode(ep)).not.toThrow();
  });
});

describe('BullMQ Queue.add → ClientSideAPICaller', () => {
  it('emits ClientSideAPICaller per `<queue>.add(<jobName>, payload)`', async () => {
    const batch = await extract('src/producer.ts');
    const cs = callers(batch);
    expect(cs.length).toBe(2);
    const urls = cs.map((c) => c.urlLiteral).sort();
    expect(urls).toEqual(['bullmq:emails', 'bullmq:uploads']);
    for (const c of cs) {
      expect(c.httpMethod).toBe('JOB');
      expect(c.framework).toBe('bullmq');
      expect(c.egressConfidence).toBe('exact');
    }
  });

  it('does NOT emit for `.add()` on a non-Queue receiver', async () => {
    const batch = await extract('src/producer.ts');
    // The 3rd `.add()` in the fixture is on `fakeQueue` (declared, not a Queue).
    // It should be excluded from the 2 emissions.
    expect(callers(batch).length).toBe(2);
  });

  it('emits MAKES_REQUEST edge from enclosing function to caller', async () => {
    const batch = await extract('src/producer.ts');
    const makes = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(makes.length).toBe(2);
  });

  it('every emitted caller passes schema validation', async () => {
    const batch = await extract('src/producer.ts');
    for (const c of callers(batch)) expect(() => validateNode(c)).not.toThrow();
  });
});

describe('Stitching parity — producer.urlLiteral matches worker.routePattern', () => {
  it('uploads queue: caller URL matches worker pattern', async () => {
    const producerBatch = await extract('src/producer.ts');
    const workerBatch = await extract('src/worker.ts');
    const uploadCaller = callers(producerBatch).find((c) => c.urlLiteral === 'bullmq:uploads');
    const uploadEndpoint = endpoints(workerBatch).find((e) => e.routePattern === 'bullmq:uploads');
    expect(uploadCaller).toBeDefined();
    expect(uploadEndpoint).toBeDefined();
    expect(uploadCaller!.urlLiteral).toBe(uploadEndpoint!.routePattern);
  });
});

describe('BullmqPlugin contract', () => {
  it('id="bullmq" and language="ts"', () => {
    const p = new BullmqPlugin();
    expect(p.id).toBe('bullmq');
    expect(p.language).toBe('ts');
  });

  it('appliesTo returns true when bullmq is in deps', () => {
    const p = new BullmqPlugin();
    expect(p.appliesTo({
      rootDir: FIXTURE_ROOT,
      packageJson: { dependencies: { bullmq: '^4.0.0' } },
      files: [],
    })).toBe(true);
  });

  it('appliesTo returns false otherwise', () => {
    const p = new BullmqPlugin();
    expect(p.appliesTo({
      rootDir: FIXTURE_ROOT,
      packageJson: { dependencies: {} },
      files: [],
    })).toBe(false);
  });
});
