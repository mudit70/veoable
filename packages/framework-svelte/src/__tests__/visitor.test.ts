import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type ClientSideProcess, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { SveltePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/svelte');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const svelte = new SveltePlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(svelte.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

// ──────────────────────────────────────────────────────────────────────
// Svelte lifecycle hooks
// ──────────────────────────────────────────────────────────────────────

describe('svelte lifecycle hook detection', () => {
  it('detects onMount as a lifecycle_hook', async () => {
    const batch = await extract('basic', 'src/lib/component-logic.ts');
    const procs = processes(batch);
    const hook = procs.find((p) => p.name === 'onMount');
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe('lifecycle_hook');
    expect(hook!.framework).toBe('svelte');
  });

  it('detects onDestroy as a lifecycle_hook', async () => {
    const batch = await extract('basic', 'src/lib/component-logic.ts');
    const procs = processes(batch);
    const hook = procs.find((p) => p.name === 'onDestroy');
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe('lifecycle_hook');
  });

  it('every emitted process passes schema validation', async () => {
    const batch = await extract('basic', 'src/lib/component-logic.ts');
    for (const p of processes(batch)) {
      expect(() => validateNode(p)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Svelte store subscriptions
// ──────────────────────────────────────────────────────────────────────

describe('svelte store subscription detection', () => {
  it('detects store.subscribe() as a state_observer', async () => {
    const batch = await extract('basic', 'src/lib/component-logic.ts');
    const procs = processes(batch);
    const sub = procs.find((p) => p.name === 'subscribe');
    expect(sub).toBeDefined();
    expect(sub!.kind).toBe('state_observer');
  });
});

// ──────────────────────────────────────────────────────────────────────
// SvelteKit load functions
// ──────────────────────────────────────────────────────────────────────

describe('sveltekit load function detection', () => {
  it('detects exported load function in +page.ts as GET endpoint', async () => {
    const batch = await extract('basic', 'src/routes/+page.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    const loadEp = eps.find((e) => e.httpMethod === 'GET');
    expect(loadEp).toBeDefined();
    expect(loadEp!.routePattern).toBe('/');
    expect(loadEp!.framework).toBe('sveltekit');
  });

  it('detects server-side load in +page.server.ts', async () => {
    const batch = await extract('basic', 'src/routes/users/+page.server.ts');
    const eps = endpoints(batch);
    const loadEp = eps.find((e) => e.httpMethod === 'GET');
    expect(loadEp).toBeDefined();
    expect(loadEp!.routePattern).toBe('/users');
  });

  it('detects dynamic route load', async () => {
    const batch = await extract('basic', 'src/routes/users/[id]/+page.ts');
    const eps = endpoints(batch);
    const loadEp = eps.find((e) => e.httpMethod === 'GET');
    expect(loadEp).toBeDefined();
    expect(loadEp!.routePattern).toBe('/users/:id');
  });

  it('resolves handler function id for load functions', async () => {
    const batch = await extract('basic', 'src/routes/+page.ts');
    const loadEp = endpoints(batch).find((e) => e.httpMethod === 'GET');
    expect(loadEp).toBeDefined();
    expect(loadEp!.handlerFunctionId).not.toBeNull();
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extract('basic', 'src/routes/+page.ts');
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// SvelteKit form actions
// ──────────────────────────────────────────────────────────────────────

describe('sveltekit form actions detection', () => {
  it('detects default form action as POST endpoint', async () => {
    const batch = await extract('basic', 'src/routes/users/+page.server.ts');
    const eps = endpoints(batch);
    const defaultAction = eps.find((e) => e.httpMethod === 'POST' && e.routePattern === '/users');
    expect(defaultAction).toBeDefined();
    expect(defaultAction!.framework).toBe('sveltekit');
  });

  it('detects named form action with ?/name suffix', async () => {
    const batch = await extract('basic', 'src/routes/users/+page.server.ts');
    const eps = endpoints(batch);
    const deleteAction = eps.find((e) => e.httpMethod === 'POST' && e.routePattern === '/users?/delete');
    expect(deleteAction).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('SveltePlugin contract', () => {
  it('has id="svelte" and language="ts"', () => {
    const plugin = new SveltePlugin();
    expect(plugin.id).toBe('svelte');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when svelte is a dependency', () => {
    const plugin = new SveltePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { svelte: '^4.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true when @sveltejs/kit is a dependency', () => {
    const plugin = new SveltePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { devDependencies: { '@sveltejs/kit': '^2.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-Svelte project', () => {
    const plugin = new SveltePlugin();
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
  it('all nodes commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const svelte = new SveltePlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(svelte.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      const files = [
        'src/lib/component-logic.ts',
        'src/routes/+page.ts',
        'src/routes/users/+page.server.ts',
        'src/routes/users/[id]/+page.ts',
      ];

      for (const file of files) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allProcesses = store.findNodes('ClientSideProcess');
      expect(allProcesses.length).toBeGreaterThan(0);

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
