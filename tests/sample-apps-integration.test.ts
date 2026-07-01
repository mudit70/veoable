/**
 * Integration tests that run the full Adorable analysis pipeline against
 * the sample applications in examples/stack-samples/.
 *
 * These tests verify that the new framework plugins correctly detect
 * endpoints and processes in realistic (non-stub) codebases.
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { analyze, type AnalysisResult } from '@adorable/cli';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_ROOT = path.resolve(__dirname, '../examples/stack-samples');

// Track all stores opened during tests so they are always cleaned up,
// even if analyzeApp throws partway through (n4 fix).
const openStores: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const store of openStores) {
    try { store.close(); } catch { /* already closed */ }
  }
  openStores.length = 0;
});

async function analyzeApp(dirName: string): Promise<AnalysisResult> {
  const result = await analyze({
    rootDir: path.join(SAMPLES_ROOT, dirName),
    stitchMode: 'none',
  });
  openStores.push(result.store);
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Issue #27: Koa + Hapi
// ──────────────────────────────────────────────────────────────────────

describe('issue-27-koa-hapi sample app', () => {
  it('detects koa and hapi plugins', async () => {
    const result = await analyzeApp('issue-27-koa-hapi');
    expect(result.detectedPlugins).toContain('koa');
    expect(result.detectedPlugins).toContain('hapi');
  });

  it('finds Koa API endpoints', async () => {
    const result = await analyzeApp('issue-27-koa-hapi');
    const endpoints = result.store.findNodes('APIEndpoint');
    const koaEndpoints = endpoints.filter((e) => e.framework === 'koa');
    expect(koaEndpoints.length).toBeGreaterThanOrEqual(4);

    const patterns = koaEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('POST /users');
    expect(patterns).toContain('DELETE /users/:id');
  });

  it('finds Hapi API endpoints', async () => {
    const result = await analyzeApp('issue-27-koa-hapi');
    const endpoints = result.store.findNodes('APIEndpoint');
    const hapiEndpoints = endpoints.filter((e) => e.framework === 'hapi');
    expect(hapiEndpoints.length).toBeGreaterThanOrEqual(4);

    const patterns = hapiEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/users');
    expect(patterns).toContain('POST /api/users');
  });

  it('normalizes Hapi {param} to :param', async () => {
    const result = await analyzeApp('issue-27-koa-hapi');
    const endpoints = result.store.findNodes('APIEndpoint');
    const hapiEndpoints = endpoints.filter((e) => e.framework === 'hapi');
    const paramRoutes = hapiEndpoints.filter((e) => e.routePattern.includes(':'));
    expect(paramRoutes.length).toBeGreaterThan(0);
    // Should NOT contain Hapi-style {param}
    for (const ep of hapiEndpoints) {
      expect(ep.routePattern).not.toMatch(/\{/);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Issue #31: Remix + Hono
// ──────────────────────────────────────────────────────────────────────

describe('issue-31-remix-hono sample app', () => {
  it('detects hono and remix plugins', async () => {
    const result = await analyzeApp('issue-31-remix-hono');
    expect(result.detectedPlugins).toContain('hono');
    expect(result.detectedPlugins).toContain('remix');
  });

  it('finds Hono API endpoints', async () => {
    const result = await analyzeApp('issue-31-remix-hono');
    const endpoints = result.store.findNodes('APIEndpoint');
    const honoEndpoints = endpoints.filter((e) => e.framework === 'hono');
    expect(honoEndpoints.length).toBeGreaterThanOrEqual(4);

    const patterns = honoEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/users');
    expect(patterns).toContain('POST /api/users');
    expect(patterns).toContain('DELETE /api/users/:id');
  });

  it('finds Remix route endpoints from file-system routing', async () => {
    const result = await analyzeApp('issue-31-remix-hono');
    const endpoints = result.store.findNodes('APIEndpoint');
    const remixEndpoints = endpoints.filter((e) => e.framework === 'remix');
    expect(remixEndpoints.length).toBeGreaterThanOrEqual(2);

    const patterns = remixEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    // users.tsx exports loader (GET) and action (POST)
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('POST /users');
  });

  it('detects Remix dynamic segment routes', async () => {
    const result = await analyzeApp('issue-31-remix-hono');
    const endpoints = result.store.findNodes('APIEndpoint');
    const remixEndpoints = endpoints.filter((e) => e.framework === 'remix');
    const dynamicRoutes = remixEndpoints.filter((e) => e.routePattern.includes(':'));
    expect(dynamicRoutes.length).toBeGreaterThan(0);
    expect(dynamicRoutes.map((e) => e.routePattern)).toContain('/users/:id');
  });

  it('detects Remix index route', async () => {
    const result = await analyzeApp('issue-31-remix-hono');
    const endpoints = result.store.findNodes('APIEndpoint');
    const remixEndpoints = endpoints.filter((e) => e.framework === 'remix');
    const indexRoute = remixEndpoints.find((e) => e.routePattern === '/');
    expect(indexRoute).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Issue #58: Angular
// ──────────────────────────────────────────────────────────────────────

describe('issue-58-angular sample app', () => {
  it('detects angular plugin', async () => {
    const result = await analyzeApp('issue-58-angular');
    expect(result.detectedPlugins).toContain('angular');
  });

  it('finds Angular lifecycle hook processes', async () => {
    const result = await analyzeApp('issue-58-angular');
    const processes = result.store.findNodes('ClientSideProcess');
    const angularProcesses = processes.filter((p) => p.framework === 'angular');
    const lifecycleHooks = angularProcesses.filter((p) => p.kind === 'lifecycle_hook');
    expect(lifecycleHooks.length).toBeGreaterThanOrEqual(2);

    const hookNames = lifecycleHooks.map((p) => p.name);
    expect(hookNames).toContain('ngOnInit');
    expect(hookNames).toContain('ngOnDestroy');
  });

  it('finds RxJS subscribe processes', async () => {
    const result = await analyzeApp('issue-58-angular');
    const processes = result.store.findNodes('ClientSideProcess');
    const subscribes = processes.filter((p) => p.name === 'subscribe' && p.framework === 'angular');
    expect(subscribes.length).toBeGreaterThan(0);
  });

  it('finds NgRx createEffect processes', async () => {
    const result = await analyzeApp('issue-58-angular');
    const processes = result.store.findNodes('ClientSideProcess');
    const effects = processes.filter((p) => p.name === 'createEffect' && p.framework === 'angular');
    expect(effects.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Issue #59: Svelte
// ──────────────────────────────────────────────────────────────────────

describe('issue-59-svelte sample app', () => {
  it('detects svelte plugin', async () => {
    const result = await analyzeApp('issue-59-svelte');
    expect(result.detectedPlugins).toContain('svelte');
  });

  it('finds Svelte lifecycle hook processes', async () => {
    const result = await analyzeApp('issue-59-svelte');
    const processes = result.store.findNodes('ClientSideProcess');
    const svelteProcesses = processes.filter((p) => p.framework === 'svelte');
    const hooks = svelteProcesses.filter((p) => p.kind === 'lifecycle_hook');
    expect(hooks.length).toBeGreaterThanOrEqual(2);

    const hookNames = hooks.map((p) => p.name);
    expect(hookNames).toContain('onMount');
    expect(hookNames).toContain('onDestroy');
  });

  it('finds SvelteKit load endpoints', async () => {
    const result = await analyzeApp('issue-59-svelte');
    const endpoints = result.store.findNodes('APIEndpoint');
    const svelteKitEndpoints = endpoints.filter((e) => e.framework === 'sveltekit');
    expect(svelteKitEndpoints.length).toBeGreaterThanOrEqual(2);

    const getEndpoints = svelteKitEndpoints.filter((e) => e.httpMethod === 'GET');
    expect(getEndpoints.length).toBeGreaterThan(0);
  });

  it('finds SvelteKit form actions as POST endpoints', async () => {
    const result = await analyzeApp('issue-59-svelte');
    const endpoints = result.store.findNodes('APIEndpoint');
    const postEndpoints = endpoints.filter((e) => e.framework === 'sveltekit' && e.httpMethod === 'POST');
    expect(postEndpoints.length).toBeGreaterThanOrEqual(1);
  });

  it('detects dynamic SvelteKit routes', async () => {
    const result = await analyzeApp('issue-59-svelte');
    const endpoints = result.store.findNodes('APIEndpoint');
    const svelteKitEndpoints = endpoints.filter((e) => e.framework === 'sveltekit');
    const dynamicRoutes = svelteKitEndpoints.filter((e) => e.routePattern.includes(':'));
    expect(dynamicRoutes.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Issue #60: Next.js Server Actions
// ──────────────────────────────────────────────────────────────────────

describe('issue-60-nextjs-server-actions sample app', () => {
  it('detects nextjs plugin', async () => {
    const result = await analyzeApp('issue-60-nextjs-server-actions');
    expect(result.detectedPlugins).toContain('nextjs');
  });

  it('finds App Router API endpoints', async () => {
    const result = await analyzeApp('issue-60-nextjs-server-actions');
    const endpoints = result.store.findNodes('APIEndpoint');
    const routeEndpoints = endpoints.filter((e) => e.routePattern === '/api/users');
    expect(routeEndpoints.length).toBeGreaterThanOrEqual(2);

    const methods = routeEndpoints.map((e) => e.httpMethod).sort();
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });

  it('finds Server Action endpoints', async () => {
    const result = await analyzeApp('issue-60-nextjs-server-actions');
    const endpoints = result.store.findNodes('APIEndpoint');
    const serverActions = endpoints.filter((e) => e.routePattern.includes('/_server-action/'));
    expect(serverActions.length).toBeGreaterThanOrEqual(2);

    // All server actions should be POST
    for (const action of serverActions) {
      expect(action.httpMethod).toBe('POST');
    }

    const actionNames = serverActions.map((e) => e.routePattern);
    expect(actionNames.find((n) => n.includes('createUser'))).toBeDefined();
    expect(actionNames.find((n) => n.includes('deleteUser'))).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Issue #61: State Management
// ──────────────────────────────────────────────────────────────────────

describe('issue-61-state-management sample app', () => {
  it('detects state-mgmt plugin', async () => {
    const result = await analyzeApp('issue-61-state-management');
    expect(result.detectedPlugins).toContain('state-mgmt');
  });

  it('finds Redux createAsyncThunk processes', async () => {
    const result = await analyzeApp('issue-61-state-management');
    const processes = result.store.findNodes('ClientSideProcess');
    const thunks = processes.filter((p) => p.name.startsWith('createAsyncThunk:') && p.framework === 'redux');
    expect(thunks.length).toBeGreaterThanOrEqual(2);

    const names = thunks.map((p) => p.name);
    expect(names).toContain('createAsyncThunk:users/fetch');
    expect(names).toContain('createAsyncThunk:users/delete');
  });

  it('finds Redux dispatch processes', async () => {
    const result = await analyzeApp('issue-61-state-management');
    const processes = result.store.findNodes('ClientSideProcess');
    const dispatches = processes.filter((p) => p.name === 'dispatch' && p.framework === 'state-mgmt');
    expect(dispatches.length).toBeGreaterThanOrEqual(2);
  });

  it('finds Zustand create process', async () => {
    const result = await analyzeApp('issue-61-state-management');
    const processes = result.store.findNodes('ClientSideProcess');
    const zustandCreates = processes.filter((p) => p.name === 'zustand:create' && p.framework === 'zustand');
    expect(zustandCreates.length).toBe(1);
  });

  it('finds MobX autorun and reaction processes', async () => {
    const result = await analyzeApp('issue-61-state-management');
    const processes = result.store.findNodes('ClientSideProcess');
    const mobxProcesses = processes.filter((p) => p.framework === 'mobx');
    expect(mobxProcesses.length).toBeGreaterThanOrEqual(2);

    const names = mobxProcesses.map((p) => p.name);
    expect(names).toContain('autorun');
    expect(names).toContain('reaction');
  });

  it('finds Pinia defineStore process', async () => {
    const result = await analyzeApp('issue-61-state-management');
    const processes = result.store.findNodes('ClientSideProcess');
    const piniaStores = processes.filter((p) => p.name.startsWith('defineStore:') && p.framework === 'pinia');
    expect(piniaStores.length).toBe(1);
    expect(piniaStores[0].name).toBe('defineStore:users');
  });
});
