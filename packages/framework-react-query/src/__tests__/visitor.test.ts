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
import { ReactQueryPlugin } from '../react-query-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/react-query');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const rq = new ReactQueryPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(rq.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

/**
 * Extract the OrderForm.ts file PLUS api.ts so cross-file callback
 * resolution sees both. lang-ts's structural walker emits a
 * FunctionDefinition for `createOrder` in api.ts; the TRIGGERS-edge
 * target id is only walkable if api.ts is in the same store.
 */
async function extractProject(scenario: string): Promise<NodeBatch> {
  const rq = new ReactQueryPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(rq.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  const merged: NodeBatch = { nodes: [], edges: [] };
  for (const file of ['src/api.ts', 'src/OrderForm.ts']) {
    const batch = await ts.extractFile(handle, file);
    merged.nodes.push(...batch.nodes);
    merged.edges.push(...batch.edges);
  }
  return merged;
}

function functions(batch: NodeBatch): FunctionDefinition[] {
  return batch.nodes.filter((n): n is FunctionDefinition => n.nodeType === 'FunctionDefinition');
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

function edgesOfType(batch: { edges: SchemaEdge[] }, t: string): SchemaEdge[] {
  return batch.edges.filter((e) => e.edgeType === t);
}

describe('react-query visitor — process emission', () => {
  it('emits ClientSideProcess for useMutation with bare mutationFn', async () => {
    const batch = await extract('basic', 'src/OrderForm.ts');
    const procs = processes(batch);
    const useMut = procs.filter((p) => p.name === 'useMutation');
    expect(useMut.length).toBeGreaterThanOrEqual(1);
    for (const p of useMut) {
      expect(p.kind).toBe('lifecycle_hook');
      expect(p.framework).toBe('react-query');
    }
  });

  it('emits ClientSideProcess for useQuery with queryFn', async () => {
    const batch = await extract('basic', 'src/OrderForm.ts');
    const useQ = processes(batch).find((p) => p.name === 'useQuery');
    expect(useQ).toBeDefined();
    expect(useQ!.kind).toBe('lifecycle_hook');
  });

  it('TRIGGERS edges for shorthand-property mutationFn resolve to a real FunctionDefinition', async () => {
    // `{ mutationFn }` is a ShorthandPropertyAssignment. The
    // identifier's symbol points at the property; getAliasedSymbol()
    // walks one hop to the referenced value (`const mutationFn =
    // createOrder`), which then resolves through
    // `resolveFunctionDefinitionIdFromDecl` to a real FunctionDefinition.
    const batch = await extractProject('basic');
    const useMutProcesses = processes(batch).filter((p) => p.name === 'useMutation');
    const triggers = edgesOfType(batch, 'TRIGGERS').filter(
      (e) => useMutProcesses.some((p) => p.id === e.from),
    );
    const fnIds = new Set(functions(batch).map((f) => f.id));
    for (const edge of triggers) {
      expect(fnIds.has(edge.to)).toBe(true);
    }
  });

  it('emits TRIGGERS edge from useMutation process to mutationFn callback', async () => {
    const batch = await extract('basic', 'src/OrderForm.ts');
    const triggers = edgesOfType(batch, 'TRIGGERS');
    const useMut = processes(batch).filter((p) => p.name === 'useMutation');
    // At least one TRIGGERS edge per useMutation process (the bare,
    // inline, and positional shapes all resolve to a callback).
    const fromUseMut = triggers.filter((e) => useMut.some((p) => p.id === e.from));
    expect(fromUseMut.length).toBeGreaterThan(0);
  });

  it('every TRIGGERS edge points at a FunctionDefinition that actually exists in the batch', async () => {
    // The arrow `mutationFn: async (input) => createOrder(input)` IS
    // emitted as a FunctionDefinition by lang-ts (Pattern 4 of
    // inferCallbackName: object-literal property in a non-VariableDecl
    // context yields the property name `mutationFn`). The TRIGGERS
    // edge must point at that node so the flow walker can walk into
    // the arrow body, not at a synthetic id no node holds.
    //
    // The earlier `does emit some edges` test only checked that edges
    // exist; this one checks they RESOLVE.
    const batch = await extractProject('basic');
    const useMutProcesses = processes(batch).filter((p) => p.name === 'useMutation');
    const triggers = edgesOfType(batch, 'TRIGGERS').filter(
      (e) => useMutProcesses.some((p) => p.id === e.from),
    );
    expect(triggers.length).toBeGreaterThan(0);
    const fnIds = new Set(functions(batch).map((f) => f.id));
    for (const edge of triggers) {
      expect(fnIds.has(edge.to)).toBe(true);
    }
  });

  it('TRIGGERS edge for bare cross-file mutationFn resolves to the imported function', async () => {
    // `useMutation({ mutationFn: createOrder })` where createOrder is
    // imported from './api'. The TRIGGERS edge must point at the
    // FunctionDefinition lang-ts emitted in api.ts.
    const batch = await extractProject('basic');
    const orderFormProcesses = processes(batch).filter((p) => p.name === 'useMutation');
    expect(orderFormProcesses.length).toBeGreaterThan(0);

    const triggers = edgesOfType(batch, 'TRIGGERS');
    const createOrderFn = functions(batch).find((f) => f.name === 'createOrder');
    expect(createOrderFn).toBeDefined();
    // At least one TRIGGERS edge from a useMutation process points
    // directly at createOrder.
    const resolves = triggers.some(
      (e) => orderFormProcesses.some((p) => p.id === e.from) && e.to === createOrderFn!.id,
    );
    expect(resolves).toBe(true);
  });

  it('every emitted process passes schema validation', async () => {
    const batch = await extract('basic', 'src/OrderForm.ts');
    for (const p of processes(batch)) {
      expect(() => validateNode(p)).not.toThrow();
    }
  });
});

describe('react-query visitor — file gate', () => {
  it('does NOT fire on files that do not import react-query', async () => {
    // api.ts has no react-query import; no processes should be emitted.
    const batch = await extract('basic', 'src/api.ts');
    expect(processes(batch)).toHaveLength(0);
  });
});
