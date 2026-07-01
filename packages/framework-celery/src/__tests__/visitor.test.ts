import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, ClientSideAPICaller, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { CeleryPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/celery/basic');

async function extract(file: string): Promise<NodeBatch> {
  const celery = new CeleryPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(celery.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-celery visitor', () => {
  it('emits APIEndpoint for @app.task / @shared_task decorators', async () => {
    const batch = await extract('tasks.py');
    const eps = endpoints(batch);
    // process_upload, explicit_name (name='upload.process'),
    // maintenance, cleanup (name='cleanup.expired') = 4
    expect(eps.length).toBe(4);
    for (const e of eps) {
      expect(e.httpMethod).toBe('JOB');
      expect(e.framework).toBe('celery');
    }
  });

  it('honors explicit name= kwarg in the decorator', async () => {
    const batch = await extract('tasks.py');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    expect(patterns).toEqual([
      'celery:cleanup.expired',  // @shared_task(name='cleanup.expired')
      'celery:maintenance',
      'celery:process_upload',
      'celery:upload.process',   // @app.task(name='upload.process')
    ]);
  });

  it('emits ClientSideAPICaller for <task>.delay(...)', async () => {
    const batch = await extract('tasks.py');
    const cs = callers(batch);
    const delay = cs.find((c) => c.urlLiteral === 'celery:process_upload');
    expect(delay).toBeTruthy();
    expect(delay!.httpMethod).toBe('JOB');
  });

  it('emits ClientSideAPICaller for <task>.apply_async(...)', async () => {
    const batch = await extract('tasks.py');
    // `explicit_name` is `@app.task(name='upload.process')`. The
    // per-file pre-scan maps function-name → explicit name, so the
    // producer's urlLiteral matches the consumer's routePattern.
    const async = callers(batch).find((c) => c.urlLiteral === 'celery:upload.process');
    expect(async).toBeTruthy();
    expect(async!.httpMethod).toBe('JOB');
  });

  it('producer .apply_async honors explicit `name=` from the consumer decorator', async () => {
    // Regression pin for the producer/consumer mismatch bug. The
    // explicit-name pair `@app.task(name='upload.process')` +
    // `explicit_name.apply_async(...)` MUST agree on
    // urlLiteral === routePattern or the flow-stitcher won't join.
    const batch = await extract('tasks.py');
    const producer = callers(batch).find((c) => c.urlLiteral === 'celery:upload.process');
    const consumer = endpoints(batch).find((e) => e.routePattern === 'celery:upload.process');
    expect(producer).toBeTruthy();
    expect(consumer).toBeTruthy();
    expect(producer!.urlLiteral).toBe(consumer!.routePattern);
    // The bare function name MUST NOT appear as a producer urlLiteral
    // in this case — that was the pre-fix bug.
    const bareFnLeak = callers(batch).find(
      (c) => c.urlLiteral === 'celery:explicit_name',
    );
    expect(bareFnLeak).toBeUndefined();
  });

  it('emits ClientSideAPICaller for app.send_task(name, ...)', async () => {
    const batch = await extract('tasks.py');
    const cs = callers(batch);
    expect(cs.some((c) => c.urlLiteral === 'celery:upload.process')).toBe(true);
    expect(cs.some((c) => c.urlLiteral === 'celery:cleanup.expired')).toBe(true);
  });

  it('marks every caller with framework=celery', async () => {
    const batch = await extract('tasks.py');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('celery');
    }
  });

  it('emits MAKES_REQUEST edges from enclosing function to caller', async () => {
    const batch = await extract('tasks.py');
    const ids = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(ids.size);
    for (const e of edges) expect(ids.has(e.to)).toBe(true);
  });

  it('does NOT emit for unrelated @decorator on a non-celery function', async () => {
    const batch = await extract('tasks.py');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).not.toContain('celery:not_a_task');
  });

  it('rejects all emits in a file with no celery import', async () => {
    const batch = await extract('no_imports.py');
    expect(endpoints(batch)).toEqual([]);
    expect(callers(batch)).toEqual([]);
  });

  it('producer + consumer pair on the same task name share urlLiteral/routePattern', async () => {
    const batch = await extract('tasks.py');
    const processUploadCaller = callers(batch).find(
      (c) => c.urlLiteral === 'celery:process_upload',
    );
    const processUploadEndpoint = endpoints(batch).find(
      (e) => e.routePattern === 'celery:process_upload',
    );
    expect(processUploadCaller).toBeTruthy();
    expect(processUploadEndpoint).toBeTruthy();
    // The flow-stitcher matches by exact equality on these — confirm
    // that both sides agree.
    expect(processUploadCaller!.urlLiteral).toBe(processUploadEndpoint!.routePattern);
  });
});
