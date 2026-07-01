import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { ApalisPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/apalis/basic');

async function extract(file: string): Promise<NodeBatch> {
  const apalis = new ApalisPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(apalis.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-apalis visitor', () => {
  it('emits ClientSideAPICaller for each storage.push(StructLiteral { ... })', async () => {
    const batch = await extract('src/main.rs');
    const cs = callers(batch);
    // 3 producer call sites: enqueue_email, enqueue_upload, enqueue_notify
    expect(cs.length).toBe(3);
    const urls = cs.map((c) => c.urlLiteral).sort();
    expect(urls).toEqual([
      'apalis:NotifyJob',
      'apalis:ProcessUploadJob',
      'apalis:SendEmailJob',
    ]);
  });

  it('emits APIEndpoint for each WorkerBuilder...build_fn(<fn>) registration', async () => {
    const batch = await extract('src/main.rs');
    const eps = endpoints(batch);
    expect(eps.length).toBe(3);
    const patterns = eps.map((e) => e.routePattern).sort();
    expect(patterns).toEqual([
      'apalis:NotifyJob',
      'apalis:ProcessUploadJob',
      'apalis:SendEmailJob',
    ]);
  });

  it('marks every emit with httpMethod=JOB + framework=apalis', async () => {
    const batch = await extract('src/main.rs');
    for (const e of endpoints(batch)) {
      expect(e.httpMethod).toBe('JOB');
      expect(e.framework).toBe('apalis');
    }
    for (const c of callers(batch)) {
      expect(c.httpMethod).toBe('JOB');
      expect(c.framework).toBe('apalis');
    }
  });

  it('producer + consumer pair on the same job struct share urlLiteral/routePattern', async () => {
    const batch = await extract('src/main.rs');
    const producer = callers(batch).find((c) => c.urlLiteral === 'apalis:SendEmailJob');
    const consumer = endpoints(batch).find((e) => e.routePattern === 'apalis:SendEmailJob');
    expect(producer).toBeTruthy();
    expect(consumer).toBeTruthy();
    expect(producer!.urlLiteral).toBe(consumer!.routePattern);
  });

  it('emits MAKES_REQUEST edges from enclosing function to caller', async () => {
    const batch = await extract('src/main.rs');
    const ids = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(ids.size);
    for (const e of edges) expect(ids.has(e.to)).toBe(true);
  });

  it('does NOT emit for a non-apalis .push(...) on PlainQueue', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    // PlainQueue.push("...") has a string literal — extractStructName
    // returns null because it's not a struct_expression.
    expect(urls).not.toContain('apalis:PlainQueue');
  });
});
