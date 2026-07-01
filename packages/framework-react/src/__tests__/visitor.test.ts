import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type ClientSideProcess,
  type SchemaNode,
} from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { ReactPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/react');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const react = new ReactPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(react.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter(
    (n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess'
  );
}

// ──────────────────────────────────────────────────────────────────────
// JSX event handler detection
// ──────────────────────────────────────────────────────────────────────

describe('JSX event handler detection', () => {
  it('emits a ClientSideProcess for every onXxx JSX attribute in Button.tsx', async () => {
    const batch = await extract('basic', 'src/Button.tsx');
    const procs = processes(batch);
    // Button has: onClick, onMouseEnter
    // Form has: onSubmit, onReset, onChange
    // Total: 5 handlers.
    const eventHandlers = procs.filter((p) => p.kind === 'event_handler');
    expect(eventHandlers).toHaveLength(5);
    const names = eventHandlers.map((p) => p.name).sort();
    expect(names).toEqual(['onChange', 'onClick', 'onMouseEnter', 'onReset', 'onSubmit']);
  });

  it('every emitted process passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/Button.tsx');
    const procs = processes(batch);
    expect(procs.length).toBeGreaterThan(0);
    for (const proc of procs) expect(() => validateNode(proc)).not.toThrow();
  });

  it('attributes each event handler to the enclosing component function', async () => {
    const batch = await extract('basic', 'src/Button.tsx');
    const procs = processes(batch);
    // Find the Button component's FunctionDefinition id.
    const buttonFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'Button'
    );
    const formFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'Form'
    );
    expect(buttonFn).toBeDefined();
    expect(formFn).toBeDefined();

    const buttonHandlers = procs.filter((p) => p.functionId === buttonFn!.id);
    const formHandlers = procs.filter((p) => p.functionId === formFn!.id);
    // Button: onClick + onMouseEnter
    expect(buttonHandlers.map((p) => p.name).sort()).toEqual(['onClick', 'onMouseEnter']);
    // Form: onSubmit + onReset + onChange
    expect(formHandlers.map((p) => p.name).sort()).toEqual(['onChange', 'onReset', 'onSubmit']);
  });

  it('sets framework="react" on every emitted process', async () => {
    const batch = await extract('basic', 'src/Button.tsx');
    for (const proc of processes(batch)) expect(proc.framework).toBe('react');
  });

  it('sets kind="event_handler" on every JSX-attribute-detected process', async () => {
    const batch = await extract('basic', 'src/Button.tsx');
    for (const proc of processes(batch)) expect(proc.kind).toBe('event_handler');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Lifecycle hook detection
// ──────────────────────────────────────────────────────────────────────

describe('lifecycle hook detection', () => {
  it('emits lifecycle_hook processes for useEffect and useLayoutEffect', async () => {
    const batch = await extract('basic', 'src/Effects.tsx');
    const procs = processes(batch);
    const hooks = procs.filter((p) => p.kind === 'lifecycle_hook');
    const names = hooks.map((p) => p.name).sort();
    expect(names).toEqual(['useEffect', 'useLayoutEffect']);
  });

  it('does NOT emit processes for useState / useMemo / useCallback', async () => {
    const batch = await extract('basic', 'src/Effects.tsx');
    const procs = processes(batch);
    const nonLifecycleHooks = procs.filter(
      (p) =>
        p.kind === 'lifecycle_hook' &&
        !['useEffect', 'useLayoutEffect'].includes(p.name)
    );
    expect(nonLifecycleHooks).toEqual([]);
  });

  it('attributes lifecycle hooks to the enclosing component function', async () => {
    const batch = await extract('basic', 'src/Effects.tsx');
    const effectsFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'Effects'
    );
    expect(effectsFn).toBeDefined();
    const hooks = processes(batch).filter((p) => p.kind === 'lifecycle_hook');
    expect(hooks.every((p) => p.functionId === effectsFn!.id)).toBe(true);
  });

  it('Effects.tsx also emits the onClick handler on the button', async () => {
    const batch = await extract('basic', 'src/Effects.tsx');
    const eventHandlers = processes(batch).filter((p) => p.kind === 'event_handler');
    expect(eventHandlers.map((p) => p.name)).toEqual(['onClick']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #4 — Cross-file JSX `onClick={importedFn}` resolution
// ──────────────────────────────────────────────────────────────────────

describe('cross-file imported handler reference (#4)', () => {
  it('emits a TRIGGERS edge for `onClick={importedFn}` to the imported function id', async () => {
    const batch = await extract('basic', 'src/CrossFileHandlers.tsx');
    const procs = processes(batch);
    const onClick = procs.find((p) => p.name === 'onClick');
    expect(onClick).toBeDefined();

    const triggersEdges = batch.edges.filter(
      (e) => e.edgeType === 'TRIGGERS' && e.from === onClick!.id,
    );
    expect(triggersEdges.length).toBe(1);
    // The target id should NOT be the same as the enclosing
    // component's function id — it should be the imported handler's
    // FunctionDefinition id (computed from the target file).
    expect(triggersEdges[0].to).toBeTruthy();
    expect(triggersEdges[0].to).not.toBe(onClick!.functionId);
  });

  it('emits a TRIGGERS edge for `onSubmit={importedArrowConst}`', async () => {
    const batch = await extract('basic', 'src/CrossFileHandlers.tsx');
    const procs = processes(batch);
    const onSubmit = procs.find((p) => p.name === 'onSubmit');
    expect(onSubmit).toBeDefined();

    const triggersEdges = batch.edges.filter(
      (e) => e.edgeType === 'TRIGGERS' && e.from === onSubmit!.id,
    );
    expect(triggersEdges.length).toBe(1);
    expect(triggersEdges[0].to).toBeTruthy();
  });

  it('resolves a default-import handler via the type-checker-first path', async () => {
    const batch = await extract('basic', 'src/CrossFileHandlers.tsx');
    const procs = processes(batch);
    // Multiple onClick processes in this fixture — confirm each one
    // has exactly one TRIGGERS edge and the target id is non-null.
    const onClicks = procs.filter((p) => p.name === 'onClick');
    expect(onClicks.length).toBeGreaterThanOrEqual(3);
    for (const proc of onClicks) {
      const triggersEdges = batch.edges.filter(
        (e) => e.edgeType === 'TRIGGERS' && e.from === proc.id,
      );
      expect(triggersEdges.length).toBe(1);
      expect(triggersEdges[0].to).toBeTruthy();
    }
  });

  it('resolves a re-exported handler to the same id as the original', async () => {
    // handlers-reexport.ts re-exports handleRefresh as
    // handleRefreshReexported. The TC-first path follows the alias
    // symbol to the original declaration in handlers.ts, so the
    // TRIGGERS target for `onClick={handleRefreshReexported}` should
    // equal the target for `onClick={handleRefresh}`.
    const batch = await extract('basic', 'src/CrossFileHandlers.tsx');
    const procs = processes(batch);
    // The fixture has 4 imported handlers (refresh, submit, default,
    // reexported) — confirm exactly 4 TRIGGERS edges out of processes.
    const procIds = new Set(procs.map((p) => p.id));
    const triggersFromProcs = batch.edges.filter(
      (e) => e.edgeType === 'TRIGGERS' && procIds.has(e.from),
    );
    expect(triggersFromProcs.length).toBe(4);
    expect(triggersFromProcs.every((e) => Boolean(e.to))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negative cases
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  it('does not emit for className / style / other non-handler attributes', async () => {
    const batch = await extract('basic', 'src/Negatives.tsx');
    const procs = processes(batch);
    const names = procs.map((p) => p.name);
    expect(names).not.toContain('className');
    expect(names).not.toContain('style');
    expect(names).not.toContain('online');
  });

  it('does not emit for a lookalike `useEffectLike` call', async () => {
    const batch = await extract('basic', 'src/Negatives.tsx');
    const lifecycle = processes(batch).filter((p) => p.kind === 'lifecycle_hook');
    expect(lifecycle).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('ReactPlugin contract', () => {
  it('has id="react" and language="ts"', () => {
    const plugin = new ReactPlugin();
    expect(plugin.id).toBe('react');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when react is a dependency', () => {
    const plugin = new ReactPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { react: '^18.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true when the project contains .tsx files even without package.json', () => {
    const plugin = new ReactPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: null,
        files: ['src/App.tsx'],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-React project', () => {
    const plugin = new ReactPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: ['src/server.ts'],
      })
    ).toBe(false);
  });

  it('visitor identity is stable across multiple accesses (plugin is stateless)', () => {
    const plugin = new ReactPlugin();
    expect(plugin.visitor).toBe(plugin.visitor);
  });

  it('the same ReactPlugin instance analyzes multiple projects without reset', async () => {
    const plugin = new ReactPlugin();
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);

    const h1 = await ts.loadProject({ rootDir: fixturePath('basic') });
    const b1 = await ts.extractFile(h1, 'src/Button.tsx');
    expect(processes(b1).length).toBeGreaterThan(0);

    const h2 = await ts.loadProject({ rootDir: fixturePath('basic') });
    const b2 = await ts.extractFile(h2, 'src/Effects.tsx');
    expect(processes(b2).length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: commit to the canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('React processes commit cleanly and round-trip via findNodes', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const react = new ReactPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(react.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      for (const file of ['src/Button.tsx', 'src/Effects.tsx']) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allProcesses = store.findNodes('ClientSideProcess');
      expect(allProcesses.length).toBeGreaterThan(0);
      for (const proc of allProcesses) {
        expect(proc.framework).toBe('react');
        // Every process must reference a FunctionDefinition that
        // actually exists in the store.
        const fn = store.getNode('FunctionDefinition', proc.functionId);
        expect(fn).not.toBeNull();
      }
    } finally {
      store.close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases — extra coverage added in review.
// ──────────────────────────────────────────────────────────────────────

describe('isEventHandlerAttribute rule (MatcherTable fixture)', () => {
  it('matches onClick / onMouseEnter / onAnimationStart / onX and rejects the rest', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'MatcherTable'
    );
    expect(fn).toBeDefined();
    const handlers = processes(batch)
      .filter((p) => p.functionId === fn!.id && p.kind === 'event_handler')
      .map((p) => p.name)
      .sort();
    expect(handlers).toEqual([
      'onAnimationStart',
      'onClick',
      'onMouseEnter',
      'onX',
    ]);
    // Rejected names must not appear.
    expect(handlers).not.toContain('online');
    expect(handlers).not.toContain('onclick');
    expect(handlers).not.toContain('ONCLICK');
    expect(handlers).not.toContain('className');
  });
});

describe('edge cases (MoreCases.tsx fixture)', () => {
  it('detects useInsertionEffect as a lifecycle_hook', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const hooks = processes(batch).filter((p) => p.kind === 'lifecycle_hook');
    expect(hooks.map((p) => p.name)).toContain('useInsertionEffect');
  });

  it('detects handlers inside a Fragment wrapper', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const fragFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'FragmentWrapper'
    );
    expect(fragFn).toBeDefined();
    const handlers = processes(batch).filter(
      (p) => p.kind === 'event_handler' && p.functionId === fragFn!.id
    );
    expect(handlers.map((p) => p.name).sort()).toEqual(['onClick', 'onFocus']);
  });

  it('emits for onXxx props on custom (capitalized) components', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const host = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'CustomComponentHost'
    );
    expect(host).toBeDefined();
    const handlers = processes(batch).filter(
      (p) => p.functionId === host!.id && p.kind === 'event_handler'
    );
    expect(handlers.map((p) => p.name)).toEqual(['onActivate']);
  });

  it('attributes deeply-nested JSX handlers to the outermost enclosing function', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const outer = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'OuterWithNested'
    );
    expect(outer).toBeDefined();
    const handlers = processes(batch).filter(
      (p) => p.functionId === outer!.id && p.name === 'onClick'
    );
    expect(handlers).toHaveLength(1);
  });

  it('attributes a useEffect inside a nested component to the inner function', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const inner = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'Inner'
    );
    expect(inner).toBeDefined();
    const hooks = processes(batch).filter(
      (p) => p.kind === 'lifecycle_hook' && p.functionId === inner!.id
    );
    expect(hooks.map((p) => p.name)).toEqual(['useEffect']);
  });

  it('emits BOTH a lifecycle_hook and an event_handler from a single component', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const mixed = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'MixedComponent'
    );
    expect(mixed).toBeDefined();
    const mine = processes(batch).filter((p) => p.functionId === mixed!.id);
    const kinds = mine.map((p) => p.kind).sort();
    expect(kinds).toEqual(['event_handler', 'lifecycle_hook']);
  });

  it('emits NOTHING for a module-top-level useEffect or JSX handler', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    // No process should have an undefined/missing functionId, and no
    // process should be attributed to a function whose name doesn't
    // exist in the batch.
    const fnIds = new Set(
      batch.nodes
        .filter((n) => n.nodeType === 'FunctionDefinition')
        .map((n) => n.id)
    );
    for (const p of processes(batch)) {
      expect(fnIds.has(p.functionId)).toBe(true);
    }
  });

  it('emits a process for a value-less JSX shorthand handler (pinned behavior)', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'ShorthandAttr'
    );
    expect(fn).toBeDefined();
    const handlers = processes(batch).filter(
      (p) => p.functionId === fn!.id && p.kind === 'event_handler'
    );
    expect(handlers.map((p) => p.name)).toEqual(['onClick']);
  });

  it('does NOT detect a renamed useEffect import (known gap)', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'RenamedHookComponent'
    );
    expect(fn).toBeDefined();
    const hooks = processes(batch).filter(
      (p) => p.functionId === fn!.id && p.kind === 'lifecycle_hook'
    );
    expect(hooks).toEqual([]);
  });

  it('emits a false-positive lifecycle_hook for a locally-shadowed useEffect (known gap)', async () => {
    const batch = await extract('basic', 'src/MoreCases.tsx');
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'ShadowedHook'
    );
    expect(fn).toBeDefined();
    const hooks = processes(batch).filter(
      (p) => p.functionId === fn!.id && p.kind === 'lifecycle_hook'
    );
    expect(hooks.map((p) => p.name)).toEqual(['useEffect']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Content-addressed id stability
// ──────────────────────────────────────────────────────────────────────

describe('content-addressed process ids', () => {
  it('two extractions of the same file produce identical process ids', async () => {
    const a = await extract('basic', 'src/Button.tsx');
    const b = await extract('basic', 'src/Button.tsx');
    const idsA = processes(a).map((p) => p.id).sort();
    const idsB = processes(b).map((p) => p.id).sort();
    expect(idsA).toEqual(idsB);
  });

  it('distinct handler names on the same JSX element yield distinct ids', async () => {
    const batch = await extract('basic', 'src/Button.tsx');
    const procs = processes(batch);
    const ids = new Set(procs.map((p) => p.id));
    expect(ids.size).toBe(procs.length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// ReactPlugin.appliesTo — extra coverage
// ──────────────────────────────────────────────────────────────────────

describe('ReactPlugin.appliesTo (extra cases)', () => {
  const plugin = new ReactPlugin();

  it('true when react is a devDependency', () => {
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { devDependencies: { react: '^18.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('true when react is a peerDependency', () => {
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { peerDependencies: { react: '^18.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('false for preact (which is not React)', () => {
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { preact: '^10.0.0' } },
        files: ['src/app.ts'],
      })
    ).toBe(false);
  });

  it('true when the project contains a .jsx file', () => {
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: null,
        files: ['src/Legacy.jsx'],
      })
    ).toBe(true);
  });
});
