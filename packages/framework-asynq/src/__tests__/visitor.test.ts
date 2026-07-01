import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { AsynqPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/asynq/basic');

async function extract(file: string): Promise<NodeBatch> {
  const asynq = new AsynqPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(asynq.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-asynq visitor', () => {
  it('emits APIEndpoint for mux.HandleFunc("type", handler)', async () => {
    const batch = await extract('tasks.go');
    const eps = endpoints(batch);
    // mux.HandleFunc("user:welcome", ...) + mux.HandleFunc("user:onboard", ...)
    //   + mux.Handle("email:send", ...) = 3
    expect(eps.length).toBe(3);
    for (const e of eps) {
      expect(e.httpMethod).toBe('JOB');
      expect(e.framework).toBe('asynq');
    }
  });

  it('emits routePattern as `asynq:<task-type>` per consumer', async () => {
    const batch = await extract('tasks.go');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    expect(patterns).toEqual([
      'asynq:email:send',
      'asynq:user:onboard',
      'asynq:user:welcome',
    ]);
  });

  it('emits ClientSideAPICaller for client.Enqueue(task)', async () => {
    const batch = await extract('tasks.go');
    const cs = callers(batch);
    const welcome = cs.find((c) => c.urlLiteral === 'asynq:user:welcome');
    expect(welcome).toBeTruthy();
    expect(welcome!.httpMethod).toBe('JOB');
  });

  it('emits ClientSideAPICaller for client.EnqueueContext(ctx, task)', async () => {
    const batch = await extract('tasks.go');
    const onboard = callers(batch).find((c) => c.urlLiteral === 'asynq:user:onboard');
    expect(onboard).toBeTruthy();
  });

  it('handles inline `client.Enqueue(asynq.NewTask("type", ...))`', async () => {
    const batch = await extract('tasks.go');
    const inline = callers(batch).find((c) => c.urlLiteral === 'asynq:email:send');
    expect(inline).toBeTruthy();
  });

  it('marks every caller with framework=asynq', async () => {
    const batch = await extract('tasks.go');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('asynq');
    }
  });

  it('emits MAKES_REQUEST edges from enclosing function to caller', async () => {
    const batch = await extract('tasks.go');
    const ids = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(ids.size);
    for (const e of edges) expect(ids.has(e.to)).toBe(true);
  });

  it('does NOT emit for a non-asynq mux receiver', async () => {
    const batch = await extract('tasks.go');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).not.toContain('asynq:not:asynq');
  });

  it('producer + consumer pair on the same task share urlLiteral/routePattern', async () => {
    const batch = await extract('tasks.go');
    const producer = callers(batch).find((c) => c.urlLiteral === 'asynq:user:welcome');
    const consumer = endpoints(batch).find((e) => e.routePattern === 'asynq:user:welcome');
    expect(producer).toBeTruthy();
    expect(consumer).toBeTruthy();
    expect(producer!.urlLiteral).toBe(consumer!.routePattern);
  });
});
