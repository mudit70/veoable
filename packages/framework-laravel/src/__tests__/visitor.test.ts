import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type DatabaseInteraction, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { PhpLanguagePlugin } from '@adorable/lang-php';
import { LaravelPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/php/laravel');

async function extract(file: string): Promise<NodeBatch> {
  const laravel = new LaravelPlugin();
  const php = new PhpLanguagePlugin();
  php.registerVisitor(laravel.visitor);
  const handle = await php.loadProject({ rootDir: FIXTURE_ROOT });
  return php.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

function interactions(batch: { nodes: SchemaNode[] }): DatabaseInteraction[] {
  return batch.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
}

describe('laravel route detection', () => {
  it('detects Route::get, post, put, delete, patch', async () => {
    const batch = await extract('routes.php');
    const eps = endpoints(batch);
    const methods = new Set(eps.map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
  });

  it('captures route patterns with {param} normalization', async () => {
    const batch = await extract('routes.php');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => e.routePattern);
    expect(patterns).toContain('/items');
    expect(patterns).toContain('/items/:id');
  });

  it('sets framework="laravel"', async () => {
    const batch = await extract('routes.php');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('laravel');
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extract('routes.php');
    for (const ep of endpoints(batch)) expect(() => validateNode(ep)).not.toThrow();
  });
});

describe('eloquent database interaction detection', () => {
  it('detects User::all as read', async () => {
    const batch = await extract('eloquent.php');
    const reads = interactions(batch).filter((i) => i.operation === 'read');
    expect(reads.length).toBeGreaterThan(0);
  });

  it('detects User::create as write', async () => {
    const batch = await extract('eloquent.php');
    const writes = interactions(batch).filter((i) => i.operation === 'write');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('detects User::destroy as delete', async () => {
    const batch = await extract('eloquent.php');
    const deletes = interactions(batch).filter((i) => i.operation === 'delete');
    expect(deletes.length).toBeGreaterThan(0);
  });

  it('sets orm="eloquent"', async () => {
    const batch = await extract('eloquent.php');
    for (const i of interactions(batch)) expect(i.orm).toBe('eloquent');
  });
});

describe('Laravel Route::group prefix composition (#204)', () => {
  it('composes Route::group(["prefix" => "api"], fn) → /api on each inner route', async () => {
    const batch = await extract('grouped.php');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/users');
    expect(patterns).toContain('POST /api/users');
  });

  it('composes nested groups: outer "api" + inner "admin" → /api/admin', async () => {
    const batch = await extract('grouped.php');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('POST /api/admin/login');
    expect(patterns).toContain('GET /api/admin/profile');
  });

  it('top-level routes are NOT prefixed by sibling groups', async () => {
    const batch = await extract('grouped.php');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /health');
  });

  it('un-grouped fixture (routes.php) emits unprefixed routes', async () => {
    const batch = await extract('routes.php');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    for (const p of patterns) expect(p).not.toMatch(/^\/api\b/);
  });

  it('composes Route::middleware(...)->prefix("v1")->group(fn) — chained-method syntax', async () => {
    const batch = await extract('grouped.php');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /v1/profile');
  });

  it('composes Route::prefix("v2")->group(fn) — bare chained syntax', async () => {
    const batch = await extract('grouped.php');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /v2/teams');
  });
});

describe('LaravelPlugin contract', () => {
  it('has id="laravel" and language="php"', () => {
    const plugin = new LaravelPlugin();
    expect(plugin.id).toBe('laravel');
    expect(plugin.language).toBe('php');
  });
});
