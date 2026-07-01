import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  __resetConfidenceDecisionWarning,
  initObservability,
  resetObservability,
} from '@veoable/observability';
import { makeBatchMeta } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import {
  idFor,
  validateEdge,
  type CallsFunctionEdge,
  type SchemaNode,
  type NodeBatch,
} from '@veoable/schema';
import { TsLanguagePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/callgraph/ts');

function fixturePath(scenario: string): string {
  return path.join(FIXTURE_ROOT, scenario);
}

function fnsByName(batch: NodeBatch, name: string): SchemaNode[] {
  return batch.nodes.filter((n) => n.nodeType === 'FunctionDefinition' && n.name === name);
}

function functionId(batch: NodeBatch, name: string): string | undefined {
  const fn = fnsByName(batch, name)[0];
  return fn?.id;
}

function callsByName(batch: NodeBatch, fromName: string): CallsFunctionEdge[] {
  const id = functionId(batch, fromName);
  if (!id) return [];
  return batch.edges.filter(
    (e): e is CallsFunctionEdge => e.edgeType === 'CALLS_FUNCTION' && e.from === id
  );
}

// ──────────────────────────────────────────────────────────────────────
// Cross-file resolution beyond the basic case
// ──────────────────────────────────────────────────────────────────────

describe('cross-file CALLS_FUNCTION — additional shapes', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-cross-file') });
    batch = await plugin.extractFile(handle, 'src/callers.ts');
  });

  it('emits a direct edge to a variable-bound arrow exported from another file', () => {
    const calls = callsByName(batch, 'callsArrow');
    expect(calls).toHaveLength(1);
    expect(calls[0].confidence).toBe('direct');
    const arrowsFileId = idFor.sourceFile({
      repository: 'calls-cross-file',
      filePath: 'src/arrows.ts',
    });
    const greetId = idFor.functionDefinition({
      sourceFileId: arrowsFileId,
      name: 'greet',
      sourceLine: 2,
    });
    expect(calls[0].to).toBe(greetId);
  });

  it('emits a direct edge to a default-exported function declaration in another file', () => {
    const calls = callsByName(batch, 'callsDefault');
    expect(calls).toHaveLength(1);
    expect(calls[0].confidence).toBe('direct');
    const defaultFileId = idFor.sourceFile({
      repository: 'calls-cross-file',
      filePath: 'src/default-fn.ts',
    });
    const defaultHelperId = idFor.functionDefinition({
      sourceFileId: defaultFileId,
      name: 'defaultHelper',
      sourceLine: 2,
    });
    expect(calls[0].to).toBe(defaultHelperId);
  });

  it('emits a method-confidence edge for a namespace-imported function call (`ns.nsFn()`)', () => {
    const calls = callsByName(batch, 'callsNamespace');
    expect(calls).toHaveLength(1);
    expect(calls[0].confidence).toBe('method');
    const nsFileId = idFor.sourceFile({
      repository: 'calls-cross-file',
      filePath: 'src/namespace-target.ts',
    });
    const nsFnId = idFor.functionDefinition({
      sourceFileId: nsFileId,
      name: 'nsFn',
      sourceLine: 2,
    });
    expect(calls[0].to).toBe(nsFnId);
  });

  it('does NOT emit any CALLS_FUNCTION edge for an external callee like console.log', () => {
    const calls = callsByName(batch, 'callsExternal');
    expect(calls).toHaveLength(0);
  });

  it('all emitted edges validate against the canonical schema', () => {
    for (const edge of batch.edges) expect(() => validateEdge(edge)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Confidence-decision span events (the hard rule)
// ──────────────────────────────────────────────────────────────────────

describe('confidence-decision span events are recorded for indirect/dynamic', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(async () => {
    await resetObservability();
    __resetConfidenceDecisionWarning();
    exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    initObservability({ provider });
  });

  afterEach(async () => {
    await resetObservability();
    exporter.reset();
  });

  it('records a ConfidenceDecision event for every dynamic / indirect callee in unresolvable fixture', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('unresolvable') });
    await plugin.extractFile(handle, 'src/index.ts');

    const spans = exporter.getFinishedSpans();
    const events = spans.flatMap((s) => s.events).filter((e) => e.name === 'ConfidenceDecision');
    const reasons = events.map((e) => String(e.attributes?.reason));

    // Each of the four bad call sites should record a decision event.
    expect(reasons).toContain('computed property access');
    expect(reasons).toContain('callback passed as parameter');
    expect(reasons).toContain('non-trivial callee expression');
    // The `runtimeValue` shape resolves to a non-function variable.
    expect(reasons).toContain('identifier resolves to a non-function variable');

    // Each of those events also carries the call.confidence attribute.
    for (const ev of events) {
      const conf = ev.attributes?.['call.confidence'];
      expect(conf === 'indirect' || conf === 'dynamic').toBe(true);
    }
  });

  it('records NO ConfidenceDecision event for an external (console.log) callee', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-cross-file') });
    await plugin.extractFile(handle, 'src/callers.ts');

    const spans = exporter.getFinishedSpans();
    const events = spans.flatMap((s) => s.events).filter((e) => e.name === 'ConfidenceDecision');
    // None of the recorded reasons should refer to a console / external call —
    // externals are silently swallowed at this layer.
    for (const ev of events) {
      expect(String(ev.attributes?.reason)).not.toMatch(/console/);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Walker shapes — recursion, classes, accessors, anonymous, chains
// ──────────────────────────────────────────────────────────────────────

describe('recursive walker — function shapes and call attribution', () => {
  let batch: NodeBatch;

  beforeEach(async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('walker-shapes') });
    batch = await plugin.extractFile(handle, 'src/index.ts');
  });

  it('emits arrow-bound `arrowFn` exactly once (no double-emit)', () => {
    expect(fnsByName(batch, 'arrowFn')).toHaveLength(1);
  });

  it('emits both the arrow `arrowFnWithNested` and the nested `nestedInArrow`', () => {
    expect(fnsByName(batch, 'arrowFnWithNested')).toHaveLength(1);
    expect(fnsByName(batch, 'nestedInArrow')).toHaveLength(1);
  });

  it('does NOT emit anonymous arrows passed as expression arguments (arr.map(x => x+1))', () => {
    // The walker should not produce a FunctionDefinition with no name.
    const anon = batch.nodes.filter(
      (n) => n.nodeType === 'FunctionDefinition' && (n.name === '' || n.name === '<anonymous>')
    );
    expect(anon).toHaveLength(0);
  });

  it('attributes the call inside `nestedInArrow` to the nested function, not the outer arrow', () => {
    const helperId = functionId(batch, 'helper')!;
    const nestedCalls = callsByName(batch, 'nestedInArrow');
    expect(nestedCalls.some((e) => e.to === helperId)).toBe(true);

    const outerCalls = callsByName(batch, 'arrowFnWithNested');
    // outer should call only nestedInArrow, not helper directly.
    expect(outerCalls.some((e) => e.to === helperId)).toBe(false);
  });

  it('emits FunctionDefinition nodes for class constructor, getter, and setter', () => {
    expect(functionId(batch, 'Svc.constructor')).toBeDefined();
    expect(functionId(batch, 'Svc.get value')).toBeDefined();
    expect(functionId(batch, 'Svc.set value')).toBeDefined();
  });

  it('attributes calls inside the constructor / getter / setter to the right enclosing function', () => {
    const helperId = functionId(batch, 'helper')!;
    expect(callsByName(batch, 'Svc.constructor').some((e) => e.to === helperId)).toBe(true);
    expect(callsByName(batch, 'Svc.get value').some((e) => e.to === helperId)).toBe(true);
    expect(callsByName(batch, 'Svc.set value').some((e) => e.to === helperId)).toBe(true);
  });

  it('resolves a non-this method call: `new Svc().compute()` → `Svc.compute` with method confidence', () => {
    const computeId = functionId(batch, 'Svc.compute')!;
    const calls = callsByName(batch, 'callsInstanceMethod');
    const edge = calls.find((e) => e.to === computeId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('method');
  });

  it('resolves a static method call: `Svc.staticOne()` → `Svc.staticOne` with method confidence', () => {
    const staticId = functionId(batch, 'Svc.staticOne')!;
    const calls = callsByName(batch, 'callsStaticMethod');
    const edge = calls.find((e) => e.to === staticId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('method');
  });

  it('records two CALLS_FUNCTION edges with the same sourceLine for `helperA() + helperB()`', () => {
    const calls = callsByName(batch, 'multipleOnLine');
    const aId = functionId(batch, 'helperA')!;
    const bId = functionId(batch, 'helperB')!;
    const a = calls.find((e) => e.to === aId)!;
    const b = calls.find((e) => e.to === bId)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.sourceLine).toBe(b.sourceLine);
  });

  it('attributes a call inside `await foo()` to the enclosing async function', () => {
    const calls = callsByName(batch, 'callsAwait');
    // helper is wrapped in Promise.resolve(...) which is itself external,
    // so we should at least see no crash and at least the helper edge.
    const helperId = functionId(batch, 'helper')!;
    expect(calls.some((e) => e.to === helperId)).toBe(true);
  });

  it('emits multiple edges for chained calls `chained().compute()`', () => {
    const calls = callsByName(batch, 'callsChain');
    // chained() — direct, Svc.compute — method.
    const chainedId = functionId(batch, 'chained')!;
    const computeId = functionId(batch, 'Svc.compute')!;
    expect(calls.some((e) => e.to === chainedId && e.confidence === 'direct')).toBe(true);
    expect(calls.some((e) => e.to === computeId && e.confidence === 'method')).toBe(true);
  });

  it('emits methods on a variable-bound class expression as `BoundCls.foo`', () => {
    expect(functionId(batch, 'BoundCls.foo')).toBeDefined();
  });

  it('emits methods on an anonymous class expression as `<anonymous-class>.bar`', () => {
    expect(functionId(batch, '<anonymous-class>.bar')).toBeDefined();
  });

  it('all walker-shapes edges validate against the canonical schema', () => {
    for (const edge of batch.edges) expect(() => validateEdge(edge)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Dynamic import resolver — extensions and dynamic specifiers
// ──────────────────────────────────────────────────────────────────────

describe('dynamic import resolver', () => {
  it('resolves .tsx, .mjs, and .cjs targets and emits IMPORTS edges with isDynamic: true', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('dynamic-import-extensions') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');

    const dyn = batch.edges.filter((e) => e.edgeType === 'IMPORTS' && e.isDynamic);
    const tos = dyn.map((e) => e.to);

    expect(tos).toContain(
      idFor.sourceFile({ repository: 'dynamic-import-extensions', filePath: 'src/a.tsx' })
    );
    expect(tos).toContain(
      idFor.sourceFile({ repository: 'dynamic-import-extensions', filePath: 'src/b.mjs' })
    );
    expect(tos).toContain(
      idFor.sourceFile({ repository: 'dynamic-import-extensions', filePath: 'src/c.cjs' })
    );

    // Non-string-literal specifier (`import(dyn)`) is silently dropped.
    expect(dyn).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Idempotency
// ──────────────────────────────────────────────────────────────────────

describe('extractor idempotency for CALLS_FUNCTION', () => {
  it('two extractFile calls on the same source file produce identical batches', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    const a = await plugin.extractFile(handle, 'src/index.ts');
    const b = await plugin.extractFile(handle, 'src/index.ts');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: lang-ts → schema → graph-db
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end lang-ts → SQLiteCanonicalGraphStore', () => {
  it('committed CALLS_FUNCTION edges are queryable via findEdges', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');

    const store = new SQLiteCanonicalGraphStore(':memory:');
    store.commit(batch, makeBatchMeta(plugin.id));

    const callerId = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'caller'
    )!.id;
    const helperId = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'helper'
    )!.id;

    const edges = store.findEdges(callerId, helperId, 'CALLS_FUNCTION');
    expect(edges).toHaveLength(1);
    expect(edges[0].edgeType).toBe('CALLS_FUNCTION');
  });
});
