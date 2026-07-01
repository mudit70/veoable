import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateNode, type ClientSideProcess } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { VuePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/vue/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new VuePlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

function processes(batch: NodeBatch): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

describe('Vue composition-API detection (#57)', () => {
  let batch: NodeBatch;
  beforeAll(async () => {
    batch = await extract('src/App.ts');
  });

  it('emits ClientSideProcess for onMounted / onUpdated / onUnmounted lifecycle hooks', () => {
    const names = new Set(processes(batch).map((p) => p.name));
    expect(names.has('onMounted')).toBe(true);
    expect(names.has('onUpdated')).toBe(true);
    expect(names.has('onUnmounted')).toBe(true);
  });

  it('labels lifecycle hooks with kind="lifecycle_hook"', () => {
    const lifecycleHooks = processes(batch).filter((p) =>
      ['onMounted', 'onUpdated', 'onUnmounted'].includes(p.name),
    );
    for (const hook of lifecycleHooks) {
      expect(hook.kind).toBe('lifecycle_hook');
    }
  });

  it('emits ClientSideProcess for watch / watchEffect with kind="event_handler"', () => {
    const watchers = processes(batch).filter((p) =>
      ['watch', 'watchEffect'].includes(p.name),
    );
    expect(watchers.length).toBeGreaterThanOrEqual(2);
    for (const w of watchers) {
      expect(w.kind).toBe('event_handler');
    }
  });

  it('emits framework="vue" on every process', () => {
    const procs = processes(batch);
    expect(procs.length).toBeGreaterThan(0);
    for (const p of procs) expect(p.framework).toBe('vue');
  });

  it('emits a TRIGGERS edge from each hook process to its inline callback', () => {
    const triggersEdges = batch.edges.filter((e) => e.edgeType === 'TRIGGERS');
    const procs = processes(batch);
    // Every lifecycle hook / watcher in the fixture uses an inline arrow
    // callback — expect one TRIGGERS edge per process.
    expect(triggersEdges.length).toBe(procs.length);
  });

  it('every emitted ClientSideProcess validates against the schema', () => {
    for (const p of processes(batch)) {
      expect(() => validateNode(p)).not.toThrow();
    }
  });
});

describe('VuePlugin.appliesTo', () => {
  it('activates on `vue` dep', () => {
    const plugin = new VuePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { vue: '^3.4.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('activates on `nuxt` dep (Nuxt 3 also uses Vue) (#370)', () => {
    const plugin = new VuePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { nuxt: '^3.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('does not activate without Vue / Nuxt deps', () => {
    const plugin = new VuePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { react: '^18.0.0' } },
        files: [],
      }),
    ).toBe(false);
  });

  it('does not activate when packageJson is null', () => {
    const plugin = new VuePlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: null, files: [] })).toBe(false);
  });
});
