import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type ClientSideProcess,
  type FunctionDefinition,
  type SchemaNode,
  type SchemaEdge,
} from '@adorable/schema';
import { type NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { SwrPlugin } from '../swr-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/swr');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extractProject(scenario: string): Promise<NodeBatch> {
  const swr = new SwrPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(swr.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  const merged: NodeBatch = { nodes: [], edges: [] };
  for (const file of ['src/api.ts', 'src/OrdersList.ts']) {
    const batch = await ts.extractFile(handle, file);
    merged.nodes.push(...batch.nodes);
    merged.edges.push(...batch.edges);
  }
  return merged;
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}
function functions(batch: NodeBatch): FunctionDefinition[] {
  return batch.nodes.filter((n): n is FunctionDefinition => n.nodeType === 'FunctionDefinition');
}
function edgesOfType(batch: { edges: SchemaEdge[] }, t: string): SchemaEdge[] {
  return batch.edges.filter((e) => e.edgeType === t);
}

describe('swr visitor — process emission', () => {
  it('emits ClientSideProcess (lifecycle_hook, framework="swr") per useSWR call', async () => {
    const batch = await extractProject('basic');
    const useSWR = processes(batch).filter((p) => p.name === 'useSWR');
    expect(useSWR.length).toBeGreaterThanOrEqual(2); // bare + inline
    for (const p of useSWR) {
      expect(p.kind).toBe('lifecycle_hook');
      expect(p.framework).toBe('swr');
    }
  });

  it('emits ClientSideProcess for useSWRMutation', async () => {
    const batch = await extractProject('basic');
    const mut = processes(batch).find((p) => p.name === 'useSWRMutation');
    expect(mut).toBeDefined();
    expect(mut!.framework).toBe('swr');
  });

  it('emits ClientSideProcess for useSWRSubscription', async () => {
    const batch = await extractProject('basic');
    const sub = processes(batch).find((p) => p.name === 'useSWRSubscription');
    expect(sub).toBeDefined();
    expect(sub!.framework).toBe('swr');
  });

  it('emits ClientSideProcess for preload (imperative, inside a function)', async () => {
    const batch = await extractProject('basic');
    const pre = processes(batch).find((p) => p.name === 'preload');
    expect(pre).toBeDefined();
    expect(pre!.framework).toBe('swr');
  });

  it('does NOT emit a process for module-scope preload (lang-ts has no module FD to anchor it)', async () => {
    // The fixture has TWO preload calls: one inside OrdersList() and
    // one at module scope. Currently lang-ts emits no module-level
    // FunctionDefinition, so the visitor skips the module-scope call
    // rather than synthesize a dangling functionId. This test locks
    // that behavior in until lang-ts changes its module-FD policy.
    const batch = await extractProject('basic');
    const preloadProcs = processes(batch).filter((p) => p.name === 'preload');
    expect(preloadProcs.length).toBe(1);
  });

  it('every TRIGGERS edge resolves to a real FunctionDefinition in the batch', async () => {
    const batch = await extractProject('basic');
    const swrProcs = processes(batch);
    const triggers = edgesOfType(batch, 'TRIGGERS').filter(
      (e) => swrProcs.some((p) => p.id === e.from),
    );
    expect(triggers.length).toBeGreaterThan(0);
    const fnIds = new Set(functions(batch).map((f) => f.id));
    for (const edge of triggers) {
      expect(fnIds.has(edge.to)).toBe(true);
    }
  });

  it('schema validates each emitted process', async () => {
    const batch = await extractProject('basic');
    for (const p of processes(batch)) {
      expect(() => validateNode(p)).not.toThrow();
    }
  });
});

describe('swr visitor — file gate', () => {
  it('does NOT fire on files that do not import swr', async () => {
    const swr = new SwrPlugin();
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(swr.visitor);
    const handle = await ts.loadProject({ rootDir: fixturePath('basic') });
    const batch = await ts.extractFile(handle, 'src/api.ts');
    expect(processes(batch)).toHaveLength(0);
  });
});
