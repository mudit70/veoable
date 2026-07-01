/**
 * Integration tests for full-stack framework plugins (#28, #44, #45, #46, #51, #52, #55).
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

// ──────────────────────────────────────────────────────────────────────
// #28: Spring Boot endpoint detection
// ──────────────────────────────────────────────────────────────────────

describe('issue-28-spring sample app', () => {
  it('detects spring plugin', async () => {
    const result = await analyzeApp('issue-28-spring');
    expect(result.detectedPlugins).toContain('spring');
  });

  it('finds Spring Boot endpoints with class-level prefix', async () => {
    const result = await analyzeApp('issue-28-spring');
    const endpoints = result.store.findNodes('APIEndpoint');
    const springEndpoints = endpoints.filter((e) => e.framework === 'spring');
    expect(springEndpoints.length).toBeGreaterThanOrEqual(6);

    const patterns = springEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/users');
    expect(patterns).toContain('POST /api/users');
    expect(patterns).toContain('DELETE /api/users/{id}');
  });

  it('detects endpoints without class prefix', async () => {
    const result = await analyzeApp('issue-28-spring');
    const endpoints = result.store.findNodes('APIEndpoint');
    const health = endpoints.find((e) => e.routePattern === '/health');
    expect(health).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// #52: GORM database interaction detection
// ──────────────────────────────────────────────────────────────────────

describe('issue-52-gorm sample app', () => {
  it('detects gorm plugin', async () => {
    const result = await analyzeApp('issue-52-gorm');
    expect(result.detectedPlugins).toContain('gorm');
  });

  it('finds GORM database interactions', async () => {
    const result = await analyzeApp('issue-52-gorm');
    const interactions = result.store.findNodes('DatabaseInteraction');
    const gormInteractions = interactions.filter((i) => i.orm === 'gorm');
    expect(gormInteractions.length).toBeGreaterThanOrEqual(5);

    const ops = new Set(gormInteractions.map((i) => i.operation));
    expect(ops).toContain('read');
    expect(ops).toContain('write');
    expect(ops).toContain('delete');
    expect(ops).toContain('raw');
  });
});

// ──────────────────────────────────────────────────────────────────────
// #55: Laravel Eloquent detection
// ──────────────────────────────────────────────────────────────────────

describe('issue-55-laravel sample app', () => {
  it('detects laravel plugin', async () => {
    const result = await analyzeApp('issue-55-laravel');
    expect(result.detectedPlugins).toContain('laravel');
  });

  it('finds Laravel Route endpoints', async () => {
    const result = await analyzeApp('issue-55-laravel');
    const endpoints = result.store.findNodes('APIEndpoint');
    const laravelEndpoints = endpoints.filter((e) => e.framework === 'laravel');
    expect(laravelEndpoints.length).toBeGreaterThanOrEqual(4);

    const patterns = laravelEndpoints.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('POST /users');
    expect(patterns).toContain('DELETE /users/:id');
  });

  it('finds Eloquent database interactions', async () => {
    const result = await analyzeApp('issue-55-laravel');
    const interactions = result.store.findNodes('DatabaseInteraction');
    const eloquentInteractions = interactions.filter((i) => i.orm === 'eloquent');
    expect(eloquentInteractions.length).toBeGreaterThan(0);
  });
});
