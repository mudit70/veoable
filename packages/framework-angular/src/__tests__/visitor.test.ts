import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type ClientSideProcess, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { AngularPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/angular');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const angular = new AngularPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(angular.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

// ──────────────────────────────────────────────────────────────────────
// Angular lifecycle hooks
// ──────────────────────────────────────────────────────────────────────

describe('angular lifecycle hook detection', () => {
  it('detects ngOnInit as a lifecycle_hook process', async () => {
    const batch = await extract('basic', 'src/users.component.ts');
    const procs = processes(batch);
    const onInit = procs.find((p) => p.name === 'ngOnInit');
    expect(onInit).toBeDefined();
    expect(onInit!.kind).toBe('lifecycle_hook');
    expect(onInit!.framework).toBe('angular');
  });

  it('detects ngOnDestroy as a lifecycle_hook process', async () => {
    const batch = await extract('basic', 'src/users.component.ts');
    const procs = processes(batch);
    const onDestroy = procs.find((p) => p.name === 'ngOnDestroy');
    expect(onDestroy).toBeDefined();
    expect(onDestroy!.kind).toBe('lifecycle_hook');
  });

  it('detects ngOnChanges as a lifecycle_hook process', async () => {
    const batch = await extract('basic', 'src/users.component.ts');
    const procs = processes(batch);
    const onChange = procs.find((p) => p.name === 'ngOnChanges');
    expect(onChange).toBeDefined();
    expect(onChange!.kind).toBe('lifecycle_hook');
  });

  it('every emitted process passes schema validation', async () => {
    const batch = await extract('basic', 'src/users.component.ts');
    for (const p of processes(batch)) {
      expect(() => validateNode(p)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// RxJS subscribe detection
// ──────────────────────────────────────────────────────────────────────

describe('RxJS subscribe detection', () => {
  it('detects .subscribe() calls as state_observer processes', async () => {
    const batch = await extract('basic', 'src/users.component.ts');
    const procs = processes(batch);
    const subscribes = procs.filter((p) => p.name === 'subscribe');
    expect(subscribes.length).toBeGreaterThan(0);
    for (const s of subscribes) {
      expect(s.kind).toBe('state_observer');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// NgRx createEffect detection
// ──────────────────────────────────────────────────────────────────────

describe('NgRx effect detection', () => {
  it('detects createEffect as a state_observer process', async () => {
    const batch = await extract('basic', 'src/user.effects.ts');
    const procs = processes(batch);
    const effect = procs.find((p) => p.name === 'createEffect');
    expect(effect).toBeDefined();
    expect(effect!.kind).toBe('state_observer');
    expect(effect!.framework).toBe('angular');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negative cases
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  it('does not emit lifecycle_hook for non-Angular methods', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const procs = processes(batch);
    const lifecycleHooks = procs.filter((p) => p.kind === 'lifecycle_hook');
    expect(lifecycleHooks).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('AngularPlugin contract', () => {
  it('has id="angular" and language="ts"', () => {
    const plugin = new AngularPlugin();
    expect(plugin.id).toBe('angular');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when @angular/core is a dependency', () => {
    const plugin = new AngularPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { '@angular/core': '^17.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-Angular project', () => {
    const plugin = new AngularPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { react: '^18.0.0' } },
        files: [],
      })
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end with canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('processes commit cleanly and round-trip via findNodes', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const angular = new AngularPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(angular.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      for (const file of ['src/users.component.ts', 'src/user.effects.ts']) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allProcesses = store.findNodes('ClientSideProcess');
      expect(allProcesses.length).toBeGreaterThan(0);
      for (const p of allProcesses) {
        expect(p.framework).toBe('angular');
      }
    } finally {
      store.close();
    }
  });
});
