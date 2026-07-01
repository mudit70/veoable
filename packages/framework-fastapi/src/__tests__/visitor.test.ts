import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { FastapiPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/python/fastapi/basic');

async function extract(file: string): Promise<NodeBatch> {
  const fastapi = new FastapiPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(fastapi.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('FastAPI route detection', () => {
  it('emits unprefixed routes from app-level decorators', async () => {
    const batch = await extract('main.py');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /health');
    expect(patterns).toContain('POST /login');
  });

  it('framework is "fastapi" on every emitted endpoint', async () => {
    const batch = await extract('users.py');
    for (const ep of endpoints(batch)) {
      expect(ep.framework).toBe('fastapi');
    }
  });

  it('every endpoint passes canonical schema validation', async () => {
    const batch = await extract('main.py');
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });
});

describe('FastAPI prefix composition (#204)', () => {
  it('composes APIRouter(prefix="/users") + method path within the same file', async () => {
    const batch = await extract('users.py');
    // No `app.include_router` lives in users.py, so only the
    // router_prefix is applied.
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /users/:id');
    expect(patterns).toContain('PUT /users/:id');
    expect(patterns).toContain('DELETE /users/:id');
    // Trailing-slash route on the router collapses to /users.
    expect(patterns).toContain('GET /users/');
  });

  it('composes include_router(prefix=...) + APIRouter(prefix=...) + method path inline', async () => {
    const batch = await extract('inline.py');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    // router = APIRouter(prefix="/items"); app.include_router(router, prefix="/api/v1")
    // → /api/v1/items/{id}
    expect(patterns).toContain('GET /api/v1/items/:id');
    // App-level route is NOT prefixed by the include_router prefix.
    expect(patterns).toContain('GET /version');
  });

  it('does NOT compose include_prefix from a different file (cross-file out of scope)', async () => {
    // users.py declares the router but the include_router call lives
    // in main.py. With same-file-only composition, users.py emits
    // /users/:id (the router_prefix only). The /api gain from
    // include_router would require cross-file resolution — explicit
    // non-goal in this PR.
    const usersBatch = await extract('users.py');
    const usersPatterns = endpoints(usersBatch).map((e) => e.routePattern);
    // Verify NONE of the users routes start with /api here.
    for (const p of usersPatterns) {
      expect(p.startsWith('/api')).toBe(false);
    }
  });
});

describe('FastAPI plugin contract', () => {
  it('has id="fastapi" and language="py"', () => {
    const plugin = new FastapiPlugin();
    expect(plugin.id).toBe('fastapi');
    expect(plugin.language).toBe('py');
  });
});

// Cross-file include_router prefix composition.
//
// The plugin's onProjectLoaded scans every .py file for
// `app.include_router(tasks.router, prefix="/api")` calls and composes
// them with the matching `router = APIRouter(prefix="/tasks")`
// declaration in routers/tasks.py. The visitor consults the resulting
// map so `@router.get("")` in routers/tasks.py emits `/api/tasks`.
describe('FastAPI cross-file include_router', () => {
  const FIX = path.resolve(__dirname, '../../../../tests/fixtures/fastapi/include-router');

  async function extractWithRoot(file: string, rootDir: string): Promise<NodeBatch> {
    const fastapi = new FastapiPlugin();
    fastapi.onProjectLoaded({
      rootDir,
      repository: 'fastapi-include-fixture',
      files: ['main.py', 'routers/tasks.py', 'routers/__init__.py'],
      packageJson: null,
    } as any);
    const py = new PyLanguagePlugin();
    py.registerVisitor(fastapi.visitor);
    const handle = await py.loadProject({ rootDir });
    return py.extractFile(handle, file);
  }

  it('composes include-prefix + router-prefix across files', async () => {
    const batch = await extractWithRoot('routers/tasks.py', FIX);
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/tasks');
    expect(patterns).toContain('POST /api/tasks');
    expect(patterns).toContain('GET /api/tasks/:task_id');
    expect(patterns).toContain('DELETE /api/tasks/:task_id');
  });

  it('still emits unprefixed app-level routes from main.py', async () => {
    const batch = await extractWithRoot('main.py', FIX);
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/health');
  });
});
