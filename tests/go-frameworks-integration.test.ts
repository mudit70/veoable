/**
 * Integration tests for Go framework plugins (#22, #23).
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { analyze, type AnalysisResult } from '@veoable/cli';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_ROOT = path.resolve(__dirname, '../examples/stack-samples');

const openStores: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const store of openStores) {
    try { store.close(); } catch {}
  }
  openStores.length = 0;
});

async function analyzeApp(dir: string): Promise<AnalysisResult> {
  const result = await analyze({ rootDir: path.join(SAMPLES_ROOT, dir), stitchMode: 'none' });
  openStores.push(result.store);
  return result;
}

describe('issue-22-gin sample app', () => {
  it('detects gin plugin', async () => {
    const result = await analyzeApp('issue-22-gin');
    expect(result.detectedPlugins).toContain('gin');
  });

  it('finds Gin API endpoints', async () => {
    const result = await analyzeApp('issue-22-gin');
    const endpoints = result.store.findNodes('APIEndpoint');
    const ginEndpoints = endpoints.filter((e) => e.framework === 'gin');
    expect(ginEndpoints.length).toBeGreaterThanOrEqual(6);

    const patterns = ginEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('POST /users');
    expect(patterns).toContain('DELETE /users/:id');
  });
});

describe('issue-23-go-http sample app', () => {
  it('detects gohttp plugin', async () => {
    const result = await analyzeApp('issue-23-go-http');
    expect(result.detectedPlugins).toContain('gohttp');
  });

  it('finds net/http endpoints with Go 1.22+ method prefix', async () => {
    const result = await analyzeApp('issue-23-go-http');
    const endpoints = result.store.findNodes('APIEndpoint');
    const httpEndpoints = endpoints.filter((e) => e.framework === 'gohttp');
    expect(httpEndpoints.length).toBeGreaterThanOrEqual(3);

    const patterns = httpEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('POST /users');
  });

  it('normalizes {param} to :param', async () => {
    const result = await analyzeApp('issue-23-go-http');
    const endpoints = result.store.findNodes('APIEndpoint');
    const httpEndpoints = endpoints.filter((e) => e.framework === 'gohttp');
    const paramRoutes = httpEndpoints.filter((e) => e.routePattern.includes(':'));
    expect(paramRoutes.length).toBeGreaterThan(0);
    for (const ep of httpEndpoints) {
      expect(ep.routePattern).not.toMatch(/\{/);
    }
  });
});
