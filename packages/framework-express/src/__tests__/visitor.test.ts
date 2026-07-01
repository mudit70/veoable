import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateNode, validateEdge, type APIEndpoint, type RendersEdge, type Screen, type SchemaEdge, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { ExpressPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/express');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const express = new ExpressPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(express.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

// ──────────────────────────────────────────────────────────────────────
// #311 — Path-aliased Express receiver detection.
//
// Verifies Express's resolver follows path-aliased imports across
// files. The original #311 plan was to mirror PR #309's regex
// fallback for Prisma, but investigation showed Express's existing
// AST chain already handles path aliases via
// `getModuleSpecifierSourceFile()`. Combined with #312 (lang-ts
// baseUrl synthesis when tsconfig declares `paths` without
// `baseUrl`), this covers the real-world Next.js + Express case.
//
// Edge case the regex fallback would have addressed (project with
// no tsconfig + path-aliased imports) is fundamentally unfixable
// without orchestrator-side configuration — a regex on receiver
// text alone would re-introduce the mixed-ORM false positives that
// PR #309's review specifically rejected.
// ──────────────────────────────────────────────────────────────────────

describe('path-aliased Express receiver (#311)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-express-pathalias-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFile(rel: string, contents: string): void {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }

  function setupBaseProject(): void {
    writeFile('tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        paths: { '@/*': ['./*'] },
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['**/*.ts'],
    }, null, 2));
    writeFile('node_modules/express/index.d.ts', `
declare function express(): {
  get(path: string, handler: (...args: unknown[]) => unknown): unknown;
  post(path: string, handler: (...args: unknown[]) => unknown): unknown;
};
declare namespace express {
  function Router(): {
    get(path: string, handler: (...args: unknown[]) => unknown): unknown;
    post(path: string, handler: (...args: unknown[]) => unknown): unknown;
  };
}
export = express;
`);
    writeFile('node_modules/express/package.json', JSON.stringify({ name: 'express', types: 'index.d.ts' }));
  }

  it('detects endpoints when the Express app is imported via a path alias (default import)', async () => {
    setupBaseProject();
    writeFile('lib/server.ts', `
import express from 'express';
const app = express();
export default app;
`);
    writeFile('routes/users.ts', `
import app from '@/lib/server';
function listUsers(_req: unknown, _res: unknown) { return null; }
app.get('/users', listUsers);
app.post('/users', (_req, _res) => null);
`);

    const ts = new TsLanguagePlugin();
    ts.registerVisitor(new ExpressPlugin().visitor);
    const handle = await ts.loadProject({ rootDir: tmpRoot });
    const batch = await ts.extractFile(handle, path.join(tmpRoot, 'routes/users.ts'));
    const patterns = new Set(endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`));
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('POST /users');
  });

  it('resolves a Router() factory imported via path alias', async () => {
    setupBaseProject();
    writeFile('routes/admin.ts', `
import express from 'express';
const adminRouter = express.Router();
export { adminRouter };
`);
    writeFile('routes/index.ts', `
import { adminRouter } from '@/routes/admin';
adminRouter.get('/admin/dashboard', (_req, _res) => null);
adminRouter.post('/admin/users', (_req, _res) => null);
`);

    const ts = new TsLanguagePlugin();
    ts.registerVisitor(new ExpressPlugin().visitor);
    const handle = await ts.loadProject({ rootDir: tmpRoot });
    const batch = await ts.extractFile(handle, path.join(tmpRoot, 'routes/index.ts'));
    const patterns = new Set(endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`));
    expect(patterns).toContain('GET /admin/dashboard');
    expect(patterns).toContain('POST /admin/users');
  });

  it('resolves namespace import (`import * as express`) via path alias', async () => {
    setupBaseProject();
    writeFile('lib/api.ts', `
import * as express from 'express';
const api = express.Router();
export default api;
`);
    writeFile('routes/api.ts', `
import api from '@/lib/api';
api.get('/health', (_req, _res) => null);
`);

    const ts = new TsLanguagePlugin();
    ts.registerVisitor(new ExpressPlugin().visitor);
    const handle = await ts.loadProject({ rootDir: tmpRoot });
    const batch = await ts.extractFile(handle, path.join(tmpRoot, 'routes/api.ts'));
    const patterns = new Set(endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`));
    expect(patterns).toContain('GET /health');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Canonical `app.METHOD(path, handler)` detection
// ──────────────────────────────────────────────────────────────────────

describe('canonical app/router route detection', () => {
  let batch: NodeBatch;

  it('every emitted endpoint passes canonical schema validation', async () => {
    batch = await extract('basic', 'src/server.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(() => validateNode(ep)).not.toThrow();
  });

  it('detects every standard Express verb at least once', async () => {
    batch = await extract('basic', 'src/server.ts');
    const methods = new Set(endpoints(batch).map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('HEAD');
    expect(methods).toContain('OPTIONS');
    expect(methods).toContain('ALL');
  });

  it('captures the routePattern as a literal string', async () => {
    batch = await extract('basic', 'src/server.ts');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    expect(patterns).toContain('/users');
    expect(patterns).toContain('/users/:id');
    expect(patterns).toContain('/catch-all');
  });

  it('uppercases the HTTP method on every endpoint', async () => {
    batch = await extract('basic', 'src/server.ts');
    for (const ep of endpoints(batch)) {
      expect(ep.httpMethod).toBe(ep.httpMethod.toUpperCase());
    }
  });

  it('sets framework="express" on every endpoint', async () => {
    batch = await extract('basic', 'src/server.ts');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('express');
  });

  it('detects router-level routes the same way as app-level routes', async () => {
    batch = await extract('basic', 'src/server.ts');
    // usersRouter.get('/profile', ...) and usersRouter.post('/profile', ...)
    const profileRoutes = endpoints(batch).filter((e) => e.routePattern === '/profile');
    expect(profileRoutes.map((r) => r.httpMethod).sort()).toEqual(['GET', 'POST']);
  });

  it('treats middleware before the handler as middleware, not the handler', async () => {
    batch = await extract('basic', 'src/server.ts');
    // app.delete('/users/:id', requireAuth, inline) — the inline arrow
    // at the end is the handler. That's an inline handler, so
    // handlerFunctionId should be null (not pointing at requireAuth).
    const del = endpoints(batch).find((e) => e.httpMethod === 'DELETE' && e.routePattern === '/users/:id');
    expect(del).toBeDefined();
    expect(del!.handlerFunctionId).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Handler resolution
// ──────────────────────────────────────────────────────────────────────

describe('handler resolution', () => {
  it('resolves a same-file function-declaration handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const listEndpoint = endpoints(batch).find(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/users'
    );
    expect(listEndpoint).toBeDefined();
    expect(listEndpoint!.handlerFunctionId).not.toBeNull();

    // The handlerFunctionId should match the FunctionDefinition the
    // structural extractor emitted for `function listUsers(...)`.
    const listUsersFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'listUsers'
    );
    expect(listUsersFn).toBeDefined();
    expect(listEndpoint!.handlerFunctionId).toBe(listUsersFn!.id);
  });

  it('resolves a same-file variable-bound arrow handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const getByIdEndpoint = endpoints(batch).find(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/users/:id'
    );
    expect(getByIdEndpoint).toBeDefined();
    expect(getByIdEndpoint!.handlerFunctionId).not.toBeNull();
    const getUserByIdFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'getUserById'
    );
    expect(getUserByIdFn).toBeDefined();
    expect(getByIdEndpoint!.handlerFunctionId).toBe(getUserByIdFn!.id);
  });

  it('returns null for an inline arrow handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const post = endpoints(batch).find(
      (e) => e.httpMethod === 'POST' && e.routePattern === '/users'
    );
    expect(post).toBeDefined();
    expect(post!.handlerFunctionId).toBeNull();
  });

  it('resolves a cross-file imported handler to its FunctionDefinition id', async () => {
    const batch = await extract('basic', 'src/cross-file.ts');
    const imported = endpoints(batch).find((e) => e.routePattern === '/imported');
    expect(imported).toBeDefined();
    // With rootDir on TsVisitContext (#86), cross-file handlers are now resolved.
    expect(imported!.handlerFunctionId).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negative cases
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  let batch: NodeBatch;

  it('resolves computed paths via PATHS.users to the underlying string (#193)', async () => {
    batch = await extract('basic', 'src/negatives.ts');
    const eps = endpoints(batch);
    // Pre-#193 this was pinned as a negative ("visitor refuses to
    // invent a pattern"). After #193's widened resolveToString, the
    // PropertyAccess `PATHS.users` resolves to its literal value
    // `/users` and the route DOES emit. The other negatives in this
    // fixture (cache.get, myMap.get, fake.get) still produce zero
    // endpoints because their receivers aren't express routables.
    expect(eps.find((e) => e.routePattern === '/users')).toBeDefined();
  });

  it('ignores .get() calls on plain object literals', async () => {
    batch = await extract('basic', 'src/negatives.ts');
    // `cache.get('key')` — receiver is `{ get: ... }`, not routable.
    expect(endpoints(batch).find((e) => e.routePattern === 'key')).toBeUndefined();
  });

  it('ignores Map#get calls', async () => {
    batch = await extract('basic', 'src/negatives.ts');
    // `myMap.get('key')` — receiver is `Map`, not routable.
    expect(endpoints(batch).find((e) => e.routePattern === 'key')).toBeUndefined();
  });

  it('ignores a locally-defined function NAMED `express` that is not the real package', async () => {
    batch = await extract('basic', 'src/negatives.ts');
    // `fake.get('/fake-path', ...)` where `fake` came from the local
    // `express2` factory — name-based heuristics would have falsely
    // matched it; the AST resolver checks the import and rejects.
    expect(endpoints(batch).find((e) => e.routePattern === '/fake-path')).toBeUndefined();
  });

  it('emits exactly one endpoint from negatives.ts (the now-resolved /users via #193); other negatives still skip', async () => {
    batch = await extract('basic', 'src/negatives.ts');
    const eps = endpoints(batch);
    expect(eps).toHaveLength(1);
    expect(eps[0]!.routePattern).toBe('/users');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Endpoint id content-addressing
// ──────────────────────────────────────────────────────────────────────

describe('endpoint id content-addressing', () => {
  it('two declarations of the same (method, path) collapse to one id', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const getUsers = endpoints(batch).filter(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/users'
    );
    // There's only one `app.get('/users', listUsers)` in server.ts,
    // but verify the content addressing by constructing the id via
    // the same recipe and checking uniqueness.
    expect(getUsers).toHaveLength(1);
    const ids = new Set(endpoints(batch).map((e) => e.id));
    // All endpoints in server.ts should have distinct ids because
    // (method, path) pairs are distinct.
    expect(ids.size).toBe(endpoints(batch).length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('ExpressPlugin contract', () => {
  it('has id="express" and language="ts"', () => {
    const plugin = new ExpressPlugin();
    expect(plugin.id).toBe('express');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when express is a dependency', () => {
    const plugin = new ExpressPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-Express project', () => {
    const plugin = new ExpressPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { react: '^18.0.0' } },
        files: ['src/App.tsx'],
      })
    ).toBe(false);
  });

  it('visitor identity is stable across accesses', () => {
    const plugin = new ExpressPlugin();
    expect(plugin.visitor).toBe(plugin.visitor);
  });

  it('the same ExpressPlugin instance analyzes multiple projects without reset', async () => {
    const plugin = new ExpressPlugin();
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);

    const h1 = await ts.loadProject({ rootDir: fixturePath('basic') });
    const b1 = await ts.extractFile(h1, 'src/server.ts');
    expect(endpoints(b1).length).toBeGreaterThan(0);
    const h2 = await ts.loadProject({ rootDir: fixturePath('basic') });
    const b2 = await ts.extractFile(h2, 'src/cross-file.ts');
    expect(endpoints(b2).length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Per-verb parameterized coverage
// ──────────────────────────────────────────────────────────────────────

describe('per-verb coverage', () => {
  const VERBS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all'] as const;
  it.each(VERBS)('detects app.%s(...)', async (verb) => {
    const batch = await extract('basic', 'src/server.ts');
    const eps = endpoints(batch).filter((e) => e.httpMethod === verb.toUpperCase());
    expect(eps.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases — paths, duplicates, chained route form
// ──────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('emits paths with multiple :param segments verbatim', async () => {
    const batch = await extract('basic', 'src/edge-cases.ts');
    expect(endpoints(batch).map((e) => e.routePattern)).toContain('/users/:id/posts/:postId');
  });

  it('emits paths containing a query string suffix verbatim', async () => {
    const batch = await extract('basic', 'src/edge-cases.ts');
    expect(endpoints(batch).map((e) => e.routePattern)).toContain('/users?sort=name');
  });

  it('emits an endpoint for an empty-string path', async () => {
    const batch = await extract('basic', 'src/edge-cases.ts');
    expect(endpoints(batch).map((e) => e.routePattern)).toContain('');
  });

  it('same (method, path) declared on different lines produces distinct ids (#185)', async () => {
    // Pre-#185 the id was content-addressed on (repository, method,
    // routePattern) only and the canonical store collapsed both
    // declarations into one node — silently dropping the second.
    // Post-#185 the id incorporates filePath + lineStart so the two
    // distinct declarations are preserved as distinct endpoints.
    const batch = await extract('basic', 'src/edge-cases.ts');
    const dups = endpoints(batch).filter((e) => e.routePattern === '/dup');
    expect(dups.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(dups.map((e) => e.id));
    expect(ids.size).toBe(dups.length);
  });

  it('does NOT detect app.route("/x").get(...) chained declarations (known gap)', async () => {
    const batch = await extract('basic', 'src/edge-cases.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/chained')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pinned gaps — detected route, null handler
// ──────────────────────────────────────────────────────────────────────

describe('pinned handler-resolution gaps', () => {
  it('class-method handler (ctrl.handleRequest) → endpoint emitted, handlerFunctionId null', async () => {
    const batch = await extract('basic', 'src/pinned-gaps.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/ctrl-method');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).toBeNull();
  });

  it('.bind(this) handler → endpoint emitted, handlerFunctionId null', async () => {
    const batch = await extract('basic', 'src/pinned-gaps.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/ctrl-bound');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).toBeNull();
  });

  it('zero-argument app.get() emits no endpoint', async () => {
    const batch = await extract('basic', 'src/pinned-gaps.ts');
    // There is no path literal to match on — just assert none of the
    // emitted endpoints are garbage from the 0-arg call.
    for (const ep of endpoints(batch)) {
      expect(ep.routePattern).not.toBe('');
    }
  });

  it('single-argument app.get("/single-arg") emits no endpoint', async () => {
    const batch = await extract('basic', 'src/pinned-gaps.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/single-arg')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Renamed receivers (#180): AST-based resolution catches every binding
// that traces back to express() / Router(), regardless of variable name.
// ──────────────────────────────────────────────────────────────────────

describe('renamed receivers (AST-based resolution, #180)', () => {
  // The exact pattern from test-code-comprehension that originally
  // surfaced the bug.
  it('detects expressApp.<verb>() calls when receiver is renamed', async () => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).toContain('/renamed-app-get');
    expect(patterns).toContain('/renamed-app-post');
  });

  const RENAMED_BINDINGS = [
    '/server-get',
    '/api-post',
    '/myApp-put',
    '/underscore-app-delete',
    '/app2-patch',
  ];
  it.each(RENAMED_BINDINGS)('detects renamed Application binding (%s)', async (p) => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    expect(endpoints(batch).find((e) => e.routePattern === p)).toBeDefined();
  });

  it('detects renamed Router bindings (e.g. usersRouter)', async () => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).toContain('/users-router-get');
    expect(patterns).toContain('/users-router-post');
  });

  it('detects bindings created via aliased default-import call', async () => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/renamed-via-alias')).toBeDefined();
  });

  it('detects routes registered through a class field initialized in the field declaration', async () => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/class-field-init')).toBeDefined();
  });

  it('detects routes registered through a class field assigned in the constructor', async () => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/class-ctor-assign')).toBeDefined();
  });

  it('detects routes when the binding is reassigned later in the function scope', async () => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/let-reassigned')).toBeDefined();
  });

  it('detects routes registered through `express.Router()` (default-import property)', async () => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/namespaced-router-get')).toBeDefined();
  });

  it('detects routes after a method-chained `.use(mw).get(...)`', async () => {
    const batch = await extract('basic', 'src/renamed-receivers.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/chained-after-use')).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: commit to the canonical store
// ──────────────────────────────────────────────────────────────────────

describe('res.render → Screen + RENDERS edge (#198 PR3b)', () => {
  it('emits a Screen for each inline res.render call', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const screens = batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
    const names = new Set(screens.map((s) => s.name));
    // /login → 'auth/signin', /dashboard → 'dashboard.njk',
    // /contact → 'contact-success', /about → 'about/index',
    // /maybe → 'a/page' AND 'b/page'.
    expect(names).toContain('auth/signin');
    expect(names).toContain('dashboard.njk');
    expect(names).toContain('contact-success');
    expect(names).toContain('about/index');
    expect(names).toContain('a/page');
    expect(names).toContain('b/page');
  });

  it('emits one RENDERS edge per res.render call, from APIEndpoint to Screen', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const renders = batch.edges.filter((e): e is RendersEdge => e.edgeType === 'RENDERS');
    const eps = endpoints(batch);
    // 4 single + 2 in /maybe + 1 concise expression-body + 2 wrapped-send
    // (njk + pug) + 1 cross-file resolved (external).
    expect(renders.length).toBe(10);
    for (const r of renders) {
      // `from` must be an APIEndpoint id
      expect(eps.find((e) => e.id === r.from)).toBeDefined();
      // `to` must be one of the emitted Screens
      const screens = batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
      expect(screens.find((s) => s.id === r.to)).toBeDefined();
      // Pinned-shape fields populated
      expect(typeof r.templateName).toBe('string');
      expect(typeof r.sourceLine).toBe('number');
    }
  });

  it('every emitted RENDERS edge passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const renders = batch.edges.filter((e): e is SchemaEdge => e.edgeType === 'RENDERS');
    for (const r of renders) {
      expect(() => validateEdge(r)).not.toThrow();
    }
  });

  it('emitted Screens validate and have framework="express-ssr", routePath=null', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const screens = batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
    // 6 multi-line + 1 concise expression-body + 2 wrapped-send
    // (njk + pug) + 1 cross-file resolved (external).
    expect(screens.length).toBe(10);
    for (const s of screens) {
      expect(() => validateNode(s)).not.toThrow();
      expect(s.framework).toBe('express-ssr');
      expect(s.routePath).toBeNull();
      expect(s.componentFunctionId).toBeNull();
    }
  });

  it('skips res.send (not render)', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const renders = batch.edges.filter((e) => e.edgeType === 'RENDERS');
    const screens = batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
    // No RENDERS edge from the /api/users endpoint (which uses res.send).
    const apiUsersEp = endpoints(batch).find((e) => e.routePattern === '/api/users');
    expect(apiUsersEp).toBeDefined();
    expect(renders.find((r) => r.from === apiUsersEp!.id)).toBeUndefined();
    // No Screen named 'users' or similar.
    expect(screens.find((s) => s.name === '/api/users')).toBeUndefined();
  });

  it('skips dynamic template names (records confidence decision, no edge)', async () => {
    // /dynamic uses `res.render(tpl)` with tpl = req.query — the
    // resolver can't statically resolve. No RENDERS edge.
    const batch = await extract('basic', 'src/render.ts');
    const dynamicEp = endpoints(batch).find((e) => e.routePattern === '/dynamic');
    expect(dynamicEp).toBeDefined();
    const renders = batch.edges.filter((e): e is RendersEdge => e.edgeType === 'RENDERS');
    expect(renders.find((r) => r.from === dynamicEp!.id)).toBeUndefined();
  });

  it('Round 7: resolves cross-file handler references and walks their body', async () => {
    // /external uses an externally-defined handler function in the
    // same file but referenced by Identifier (not inline). The
    // helper now resolves the Identifier via type-checker-first and
    // walks the resolved body for res.render calls.
    const batch = await extract('basic', 'src/render.ts');
    const externalEp = endpoints(batch).find((e) => e.routePattern === '/external');
    expect(externalEp).toBeDefined();
    const renders = batch.edges.filter((e): e is RendersEdge => e.edgeType === 'RENDERS' && e.from === externalEp!.id);
    expect(renders).toHaveLength(1);
    expect(renders[0].templateName).toBe('external/page');
  });

  it('detects arrow expression-body handler: `(_,res) => res.render(...)`', async () => {
    // Pre-fix the visitor walked descendants of the body, missing the
    // case where the body IS the CallExpression itself (concise arrow
    // form). Pin the fix.
    const batch = await extract('basic', 'src/render.ts');
    const conciseEp = endpoints(batch).find((e) => e.routePattern === '/concise');
    expect(conciseEp).toBeDefined();
    const renders = batch.edges.filter((e): e is RendersEdge => e.edgeType === 'RENDERS' && e.from === conciseEp!.id);
    expect(renders).toHaveLength(1);
    expect(renders[0].templateName).toBe('concise/page');
  });

  it('handles multiple render calls in branches (both emitted)', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const maybeEp = endpoints(batch).find((e) => e.routePattern === '/maybe');
    expect(maybeEp).toBeDefined();
    const fromMaybe = batch.edges.filter((e): e is RendersEdge => e.edgeType === 'RENDERS' && e.from === maybeEp!.id);
    expect(fromMaybe.length).toBe(2);
    const names = new Set(fromMaybe.map((e) => e.templateName));
    expect(names).toEqual(new Set(['a/page', 'b/page']));
  });

  // Round 7 — wrapped-send: `res.send(nunjucks.render('foo'))` /
  // `res.send(pug.renderFile('foo'))` should emit RENDERS edges for
  // the INNER template, not the outer res.send.
  it('detects res.send(nunjucks.render(...)) and emits RENDERS for the inner template', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const njkEp = endpoints(batch).find((e) => e.routePattern === '/njk-send');
    expect(njkEp).toBeDefined();
    const fromNjk = batch.edges.filter((e): e is RendersEdge => e.edgeType === 'RENDERS' && e.from === njkEp!.id);
    expect(fromNjk).toHaveLength(1);
    expect(fromNjk[0].templateName).toBe('njk/landing.njk');
  });

  it('detects res.send(pug.renderFile(...)) similarly', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const pugEp = endpoints(batch).find((e) => e.routePattern === '/pug-send');
    expect(pugEp).toBeDefined();
    const fromPug = batch.edges.filter((e): e is RendersEdge => e.edgeType === 'RENDERS' && e.from === pugEp!.id);
    expect(fromPug).toHaveLength(1);
    expect(fromPug[0].templateName).toBe('pug/profile.pug');
  });
});

// ──────────────────────────────────────────────────────────────────────
// #194 — request-name dispatcher detection
// ──────────────────────────────────────────────────────────────────────

describe('request-name dispatcher expansion (#194)', () => {
  it('expands `app.post(path, handleAPIRequest({Foo, Bar, Baz}))` into one APIEndpoint per key', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    const eps = endpoints(batch);
    const jadePatterns = eps.map((e) => e.routePattern).filter((p) => p.startsWith('/api/jade'));
    // Base endpoint (POST /api/jade) + 3 sub-endpoints (?r=<key>).
    expect(jadePatterns).toContain('/api/jade');
    expect(jadePatterns).toContain('/api/jade?r=GetComputers');
    expect(jadePatterns).toContain('/api/jade?r=CreateComputer');
    expect(jadePatterns).toContain('/api/jade?r=DeleteComputer');
  });

  it('handles renamed wrapper parameter (`function dispatch(handlerMap)`)', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    const eps = endpoints(batch);
    const v2 = eps.map((e) => e.routePattern).filter((p) => p.startsWith('/api/v2'));
    expect(v2).toContain('/api/v2?r=Foo');
    expect(v2).toContain('/api/v2?r=Bar');
  });

  it('handles aliased local (`const h = handlers; h[req.query.r](req, res)`)', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    const eps = endpoints(batch);
    const a = eps.map((e) => e.routePattern).filter((p) => p.startsWith('/api/aliased'));
    expect(a).toContain('/api/aliased?r=Action1');
    expect(a).toContain('/api/aliased?r=Action2');
  });

  it('handles body-source dispatchers (`req.body.action`)', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    const eps = endpoints(batch);
    const b = eps.map((e) => e.routePattern).filter((p) => p.startsWith('/api/by-body'));
    expect(b).toContain('/api/by-body?action=Save');
    expect(b).toContain('/api/by-body?action=Cancel');
  });

  it('every dispatcher endpoint passes schema validation', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    for (const ep of endpoints(batch).filter((e) => /\?[\w]+=/.test(e.routePattern))) {
      expect(() => validateNode(ep)).not.toThrow();
      expect(ep.evidence?.confidence).toBe('heuristic');
    }
  });

  // Negative cases — Signal 2 must reject these.

  it('does NOT expand validate({body: schema})', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    const eps = endpoints(batch);
    const u = eps.map((e) => e.routePattern).filter((p) => p.startsWith('/users'));
    expect(u).toEqual(['/users']); // Only the original endpoint, no sub-endpoints.
  });

  it('does NOT expand auth({required, roles})', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    const eps = endpoints(batch);
    const a = eps.map((e) => e.routePattern).filter((p) => p.startsWith('/admin'));
    expect(a).toEqual(['/admin']);
  });

  it('does NOT expand graphqlHTTP({schema, rootValue})', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    const eps = endpoints(batch);
    // /graphql is registered via app.use which doesn't emit endpoints,
    // so we just verify no `/graphql?...` synthetic endpoints exist.
    const gql = eps.map((e) => e.routePattern).filter((p) => p.includes('/graphql?'));
    expect(gql).toEqual([]);
  });

  it('does NOT expand multer({...}).single("file") chain', async () => {
    const batch = await extract('basic', 'src/dispatcher.ts');
    const eps = endpoints(batch);
    const u = eps.map((e) => e.routePattern).filter((p) => p.startsWith('/upload'));
    expect(u).toEqual(['/upload']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #127 — Passport + JWT middleware naming
// ──────────────────────────────────────────────────────────────────────

describe('Passport + JWT middleware naming (#127)', () => {
  it("captures `passport.authenticate('jwt')` strategy in middlewareChain name", async () => {
    const batch = await extract('basic', 'src/passport.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/me');
    expect(ep).toBeDefined();
    expect(ep!.middlewareChain).toBeDefined();
    expect(ep!.middlewareChain![0].name).toBe("passport.authenticate('jwt')");
  });

  it('handles `passport.authenticate("jwt", { session: false })` (string strategy + opts)', async () => {
    const batch = await extract('basic', 'src/passport.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/dashboard');
    expect(ep).toBeDefined();
    expect(ep!.middlewareChain![0].name).toBe("passport.authenticate('jwt')");
  });

  it('preserves multi-step middleware chains', async () => {
    const batch = await extract('basic', 'src/passport.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/admin');
    expect(ep).toBeDefined();
    expect(ep!.middlewareChain!.length).toBe(2);
    expect(ep!.middlewareChain![0].name).toBe('passport.initialize');
    expect(ep!.middlewareChain![1].name).toBe("passport.authenticate('jwt')");
  });
});

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly and round-trip via findNodes', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const express = new ExpressPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(express.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      for (const file of ['src/server.ts', 'src/cross-file.ts', 'src/handlers.ts']) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('express');
        // Every resolved handlerFunctionId must point at a real
        // FunctionDefinition in the store.
        if (ep.handlerFunctionId) {
          const fn = store.getNode('FunctionDefinition', ep.handlerFunctionId);
          expect(fn).not.toBeNull();
        }
      }
    } finally {
      store.close();
    }
  });
});

