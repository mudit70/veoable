/**
 * Integration tests for Rust framework plugins (#24, #25, #26).
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { analyze, type AnalysisResult } from '@adorable/cli';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_ROOT = path.resolve(__dirname, '../examples/stack-samples');

const openStores: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const store of openStores) { try { store.close(); } catch {} }
  openStores.length = 0;
});

async function analyzeApp(dir: string): Promise<AnalysisResult> {
  const result = await analyze({ rootDir: path.join(SAMPLES_ROOT, dir), stitchMode: 'none' });
  openStores.push(result.store);
  return result;
}

describe('issue-24-actix sample app', () => {
  it('detects actix plugin', async () => {
    const result = await analyzeApp('issue-24-actix');
    expect(result.detectedPlugins).toContain('actix');
  });

  it('finds Actix endpoints from attribute macros', async () => {
    const result = await analyzeApp('issue-24-actix');
    const endpoints = result.store.findNodes('APIEndpoint');
    const actixEndpoints = endpoints.filter((e) => e.framework === 'actix');
    expect(actixEndpoints.length).toBeGreaterThanOrEqual(4);

    const patterns = actixEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('POST /users');
    expect(patterns).toContain('DELETE /users/:id');
  });
});

describe('issue-25-axum sample app', () => {
  it('detects axum plugin', async () => {
    const result = await analyzeApp('issue-25-axum');
    expect(result.detectedPlugins).toContain('axum');
  });

  it('finds Axum endpoints from route builder', async () => {
    const result = await analyzeApp('issue-25-axum');
    const endpoints = result.store.findNodes('APIEndpoint');
    const axumEndpoints = endpoints.filter((e) => e.framework === 'axum');
    expect(axumEndpoints.length).toBeGreaterThanOrEqual(2);
  });
});

describe('issue-26-rocket sample app', () => {
  it('detects rocket plugin', async () => {
    const result = await analyzeApp('issue-26-rocket');
    expect(result.detectedPlugins).toContain('rocket');
  });

  it('finds Rocket endpoints from attribute macros', async () => {
    const result = await analyzeApp('issue-26-rocket');
    const endpoints = result.store.findNodes('APIEndpoint');
    const rocketEndpoints = endpoints.filter((e) => e.framework === 'rocket');
    expect(rocketEndpoints.length).toBeGreaterThanOrEqual(3);

    const patterns = rocketEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('POST /users');
  });
});
