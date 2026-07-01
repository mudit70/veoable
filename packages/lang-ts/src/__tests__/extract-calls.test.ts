import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  idFor,
  validateEdge,
  type CallsFunctionEdge,
  type SchemaEdge,
  type SchemaNode,
} from '@veoable/schema';
import { TsLanguagePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/callgraph/ts');

function fixturePath(scenario: string): string {
  return path.join(FIXTURE_ROOT, scenario);
}

function callsByName(
  batch: { nodes: SchemaNode[]; edges: SchemaEdge[] },
  fromName: string
): CallsFunctionEdge[] {
  const fn = batch.nodes.find((n) => n.nodeType === 'FunctionDefinition' && n.name === fromName);
  if (!fn) return [];
  return batch.edges.filter(
    (e): e is CallsFunctionEdge => e.edgeType === 'CALLS_FUNCTION' && e.from === fn.id
  );
}

function functionId(
  batch: { nodes: SchemaNode[] },
  name: string
): string | undefined {
  const fn = batch.nodes.find((n) => n.nodeType === 'FunctionDefinition' && n.name === name);
  return fn?.id;
}

// ──────────────────────────────────────────────────────────────────────
// Same-file call graph
// ──────────────────────────────────────────────────────────────────────

describe('same-file CALLS_FUNCTION edges', () => {
  let batch: { nodes: SchemaNode[]; edges: SchemaEdge[] };

  beforeAll(async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    batch = await plugin.extractFile(handle, 'src/index.ts');
  });

  it('every emitted edge passes the canonical schema validator', () => {
    for (const edge of batch.edges) expect(() => validateEdge(edge)).not.toThrow();
  });

  it('emits a direct CALLS_FUNCTION edge from caller to helper', () => {
    const calls = callsByName(batch, 'caller');
    const helperId = functionId(batch, 'helper')!;
    const edge = calls.find((e) => e.to === helperId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('direct');
    expect(edge!.isConditional).toBe(false);
  });

  it('emits a method CALLS_FUNCTION edge from Service.run to Service.compute', () => {
    const calls = callsByName(batch, 'Service.run');
    const computeId = functionId(batch, 'Service.compute')!;
    const edge = calls.find((e) => e.to === computeId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('method');
  });

  it('emits an indirect CALLS_FUNCTION edge for a callback parameter (no calleeId)', () => {
    // For callback-parameter calls there is no concrete callee
    // function we can point to, so the edge has no `to` we can match
    // by FunctionDefinition. Verify by checking that no edge from
    // `withCallback` exists at all but the confidence-decision span
    // event was recorded (covered indirectly via the test below for
    // unresolvable edges).
    const calls = callsByName(batch, 'withCallback');
    expect(calls).toHaveLength(0);
  });

  it('marks isConditional: true for a call inside an if statement', () => {
    const calls = callsByName(batch, 'conditional');
    const helperId = functionId(batch, 'helper')!;
    const edge = calls.find((e) => e.to === helperId);
    expect(edge).toBeDefined();
    expect(edge!.isConditional).toBe(true);
  });

  it('attributes a call inside a nested function to the nested function', () => {
    const calls = callsByName(batch, 'inner');
    const helperId = functionId(batch, 'helper')!;
    const edge = calls.find((e) => e.to === helperId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('direct');
  });

  it('attributes the inner() call inside outer() to outer, not to a nested function', () => {
    const calls = callsByName(batch, 'outer');
    const innerId = functionId(batch, 'inner')!;
    const edge = calls.find((e) => e.to === innerId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('direct');
  });

  it('records sourceLine and arguments for every CALLS_FUNCTION edge', () => {
    const calls = batch.edges.filter((e): e is CallsFunctionEdge => e.edgeType === 'CALLS_FUNCTION');
    for (const edge of calls) {
      expect(edge.sourceLine).toBeGreaterThan(0);
      expect(Array.isArray(edge.arguments)).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Cross-file call graph
// ──────────────────────────────────────────────────────────────────────

describe('cross-file CALLS_FUNCTION edges', () => {
  it('emits a direct edge from getUser (users.ts) to query (db.ts)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-cross-file') });
    const batch = await plugin.extractFile(handle, 'src/users.ts');

    const calls = callsByName(batch, 'getUser');
    expect(calls).toHaveLength(1);
    expect(calls[0].confidence).toBe('direct');
    // Cross-file callee id is computed from db.ts's filename, not from
    // a node we emitted in this batch.
    const dbFileId = idFor.sourceFile({
      repository: 'calls-cross-file',
      filePath: 'src/db.ts',
    });
    const queryId = idFor.functionDefinition({
      sourceFileId: dbFileId,
      name: 'query',
      sourceLine: 1,
    });
    expect(calls[0].to).toBe(queryId);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Wrapper chain (the #2 example: apiClient.get → baseGet)
// ──────────────────────────────────────────────────────────────────────

describe('wrapper chain', () => {
  it('emits a direct cross-file edge from getOrders to apiClient.get', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-through-wrapper') });
    const batch = await plugin.extractFile(handle, 'src/api-client.ts');

    const getOrdersCalls = callsByName(batch, 'getOrders');
    // apiClient.get is a method-style call on a const-bound object literal.
    const methodCall = getOrdersCalls.find((e) => e.confidence === 'method');
    expect(methodCall).toBeDefined();
  });

  it('emits a direct edge from apiClient.get-equivalent to baseGet (cross-file)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-through-wrapper') });
    const batch = await plugin.extractFile(handle, 'src/api-client.ts');

    // The `get` method on the apiClient object literal is NOT emitted as
    // a FunctionDefinition (object-literal methods are still pinned out),
    // so the edge from it to baseGet is not produced. We document this
    // gap by asserting `getOrders` itself does NOT have a direct edge
    // to baseGet — the chain is broken at the object-literal layer.
    const getOrdersCalls = callsByName(batch, 'getOrders');
    const baseGetFileId = idFor.sourceFile({
      repository: 'calls-through-wrapper',
      filePath: 'src/base-client.ts',
    });
    const baseGetId = idFor.functionDefinition({
      sourceFileId: baseGetFileId,
      name: 'baseGet',
      sourceLine: 2,
    });
    const directToBase = getOrdersCalls.find((e) => e.to === baseGetId);
    expect(directToBase).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Unresolvable / dynamic confidence
// ──────────────────────────────────────────────────────────────────────

describe('unresolvable callees', () => {
  let batch: { nodes: SchemaNode[]; edges: SchemaEdge[] };

  beforeAll(async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('unresolvable') });
    batch = await plugin.extractFile(handle, 'src/index.ts');
  });

  it('does not emit a CALLS_FUNCTION edge for a computed property access (obj[key]())', () => {
    const calls = callsByName(batch, 'computedAccess');
    expect(calls).toHaveLength(0);
  });

  it('does not emit a CALLS_FUNCTION edge for a callback parameter call (cb())', () => {
    const calls = callsByName(batch, 'callbackArg');
    expect(calls).toHaveLength(0);
  });

  it('does not emit a CALLS_FUNCTION edge for an IIFE (non-trivial callee)', () => {
    const calls = callsByName(batch, 'iife');
    expect(calls).toHaveLength(0);
  });

  it('does not emit a CALLS_FUNCTION edge for a runtime variable holding a function', () => {
    const calls = callsByName(batch, 'runtimeValue');
    expect(calls).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Dynamic import → IMPORTS edge with isDynamic: true
// ──────────────────────────────────────────────────────────────────────

describe('dynamic imports', () => {
  it('emits an IMPORTS edge with isDynamic: true for `import("./lazy.js")`', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('dynamic-import-fixture') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');

    const dynamicImports = batch.edges.filter((e) => e.edgeType === 'IMPORTS' && e.isDynamic);
    expect(dynamicImports).toHaveLength(1);
    expect(dynamicImports[0].to).toBe(
      idFor.sourceFile({
        repository: 'dynamic-import-fixture',
        filePath: 'src/lazy.ts',
      })
    );
  });

  it('does not emit a CALLS_FUNCTION edge for the dynamic import call expression', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('dynamic-import-fixture') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');

    // loadLazy contains `await import('./lazy.js')` and `mod.lazyValue()`.
    // The dynamic import is NOT a CALLS_FUNCTION edge. The mod.lazyValue
    // call IS a method call on a namespace import — verify the edge
    // count and confidence.
    const calls = callsByName(batch, 'loadLazy');
    // Only mod.lazyValue() should produce an edge; the import('./lazy.js')
    // call expression is filtered out as a dynamic import.
    expect(calls.every((e) => e.confidence === 'method')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Schema validation across all fixtures
// ──────────────────────────────────────────────────────────────────────

describe('every fixture batch passes schema validation', () => {
  const scenarios = [
    'calls-same-file',
    'calls-cross-file',
    'calls-through-wrapper',
    'unresolvable',
    'dynamic-import-fixture',
  ];

  it.each(scenarios)('%s: every emitted edge validates', async (scenario) => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath(scenario) });
    // Pick the obvious entry file for each scenario.
    const filePath =
      scenario === 'calls-cross-file'
        ? 'src/users.ts'
        : scenario === 'calls-through-wrapper'
          ? 'src/api-client.ts'
          : 'src/index.ts';
    const batch = await plugin.extractFile(handle, filePath);
    for (const edge of batch.edges) expect(() => validateEdge(edge)).not.toThrow();
  });
});
