import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type APIEndpoint,
  type DatabaseInteraction,
  type SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { DjangoPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/python/django');
const fixturePath = (s: string) => path.join(FIXTURE_ROOT, s);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const django = new DjangoPlugin();
  // Trigger onProjectLoaded so the visitor's systemId is bound.
  django.onProjectLoaded({
    rootDir: fixturePath(scenario),
    packageJson: null,
    files: [],
  });
  const py = new PyLanguagePlugin();
  py.registerVisitor(django.visitor);
  const handle = await py.loadProject({ rootDir: fixturePath(scenario) });
  return py.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}
function interactions(batch: { nodes: SchemaNode[] }): DatabaseInteraction[] {
  return batch.nodes.filter((n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction');
}

// ──────────────────────────────────────────────────────────────────────
// Existing class-name heuristic — pins the pre-#221 behavior.
// ──────────────────────────────────────────────────────────────────────

describe('ViewSet detection — class-name heuristic', () => {
  it('emits 5 CRUD endpoints for ArticleViewSet under /api/articles/', async () => {
    const batch = await extract('basic', 'views.py');
    const eps = endpoints(batch);
    const articlesPaths = eps.map((e) => `${e.httpMethod} ${e.routePattern}`).filter((p) => p.includes('articles'));
    expect(articlesPaths).toContain('GET /api/articles');
    expect(articlesPaths).toContain('POST /api/articles');
    expect(articlesPaths).toContain('GET /api/articles/:id');
    expect(articlesPaths).toContain('PUT /api/articles/:id');
    expect(articlesPaths).toContain('DELETE /api/articles/:id');
  });

  it('pluralization: y → ies (CategoryViewSet → /api/categories)', async () => {
    const batch = await extract('basic', 'views.py');
    const eps = endpoints(batch);
    expect(eps.find((e) => e.routePattern === '/api/categories')).toBeDefined();
    expect(eps.find((e) => e.routePattern === '/api/categories/:id')).toBeDefined();
  });

  it('pluralization: x → xes (BoxViewSet → /api/boxes)', async () => {
    const batch = await extract('basic', 'views.py');
    const eps = endpoints(batch);
    expect(eps.find((e) => e.routePattern === '/api/boxes')).toBeDefined();
  });

  it('@action decorator: detail=False → /api/<plural>/<action>', async () => {
    const batch = await extract('basic', 'views.py');
    const eps = endpoints(batch);
    expect(eps.find((e) => e.routePattern === '/api/articles/featured')).toBeDefined();
  });

  it('@action decorator: detail=True → /api/<plural>/:id/<action>', async () => {
    const batch = await extract('basic', 'views.py');
    const eps = endpoints(batch);
    expect(eps.find((e) => e.routePattern === '/api/articles/:id/publish')).toBeDefined();
  });

  it('every emitted APIEndpoint passes schema validation', async () => {
    const batch = await extract('basic', 'views.py');
    for (const ep of endpoints(batch)) expect(() => validateNode(ep)).not.toThrow();
  });

  it('framework label is "django" on every endpoint', async () => {
    const batch = await extract('basic', 'views.py');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('django');
  });
});

// ──────────────────────────────────────────────────────────────────────
// ORM detection — pins existing behavior.
// ──────────────────────────────────────────────────────────────────────

describe('Django ORM detection', () => {
  it('Model.objects.all() → DatabaseInteraction with operation=read', async () => {
    const batch = await extract('basic', 'orm.py');
    const reads = interactions(batch).filter((i) => i.operation === 'read');
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });

  it('Model.objects.create(...) → DatabaseInteraction with operation=write', async () => {
    const batch = await extract('basic', 'orm.py');
    const writes = interactions(batch).filter((i) => i.operation === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it('instance.delete() → DatabaseInteraction with operation=delete', async () => {
    const batch = await extract('basic', 'orm.py');
    const deletes = interactions(batch).filter((i) => i.operation === 'delete');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #221 — cross-file urls.py prefix composition.
// ──────────────────────────────────────────────────────────────────────

describe('cross-file urls.py prefix composition (#221)', () => {
  it("path('api/v2/', include('myapp.urls')) + router.register(r'articles', ArticleViewSet) → /api/v2/articles", async () => {
    const batch = await extract('with-urls', 'myapp/views.py');
    const eps = endpoints(batch);
    expect(eps.find((e) => e.routePattern === '/api/v2/articles')).toBeDefined();
    expect(eps.find((e) => e.routePattern === '/api/v2/articles/:id')).toBeDefined();
  });

  it('does NOT emit the class-name fallback `/api/articles` when urls.py composition succeeds', async () => {
    const batch = await extract('with-urls', 'myapp/views.py');
    const eps = endpoints(batch);
    // Only the composed prefix should be present.
    expect(eps.find((e) => e.routePattern === '/api/articles')).toBeUndefined();
  });

  it('falls back to class-name heuristic for ViewSets not registered to any router', async () => {
    const batch = await extract('with-urls', 'myapp/extra.py');
    const eps = endpoints(batch);
    // TagViewSet wasn't registered → fallback /api/tags/.
    expect(eps.find((e) => e.routePattern === '/api/tags')).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract.
// ──────────────────────────────────────────────────────────────────────

describe('DjangoPlugin contract', () => {
  it('id="django" and language="py"', () => {
    const p = new DjangoPlugin();
    expect(p.id).toBe('django');
    expect(p.language).toBe('py');
  });

  it('appliesTo returns true when manage.py is present', () => {
    const p = new DjangoPlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('basic'),
        packageJson: null,
        files: ['manage.py', 'views.py'],
      }),
    ).toBe(true);
  });

  it('appliesTo returns false when no Django markers are present', () => {
    const p = new DjangoPlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('basic'),
        packageJson: null,
        files: ['unrelated.py'],
      }),
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// DRF @api_view decorator — function-based views.
// Fixture: tests/fixtures/python/django/api-view-functions/
// ──────────────────────────────────────────────────────────────────────

describe('@api_view decorator detection', () => {
  it('emits one APIEndpoint per HTTP method × resolved route', async () => {
    const batch = await extract('api-view-functions', 'myapp/views.py');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => `${e.httpMethod} ${e.routePattern}`);
    // list_create_photos → GET + POST at /api/photos/
    expect(patterns).toContain('GET /api/photos');
    expect(patterns).toContain('POST /api/photos');
  });

  it('handles stacked decorators (@api_view + @permission_classes)', async () => {
    const batch = await extract('api-view-functions', 'myapp/views.py');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('POST /api/photos/upload-url');
  });

  it('handles kwarg form @api_view(http_method_names=[...])', async () => {
    const batch = await extract('api-view-functions', 'myapp/views.py');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/photos/:photo_id');
    expect(patterns).toContain('DELETE /api/photos/:photo_id');
  });

  it('normalises Django path converters to :name', async () => {
    const batch = await extract('api-view-functions', 'myapp/views.py');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).toContain('/api/photos/:photo_id'); // <uuid:photo_id>
    expect(patterns).toContain('/api/photos/:pk/audit'); // <int:pk>
    expect(patterns).toContain('/api/photos/:tag');      // <slug:tag>
  });

  it('does NOT emit an endpoint for an undecorated function', async () => {
    const batch = await extract('api-view-functions', 'myapp/views.py');
    const handlers = endpoints(batch).map((e) => e.evidence?.snippet ?? '');
    for (const snippet of handlers) {
      expect(snippet).not.toContain('not_decorated');
    }
  });

  it('stamps handlerFunctionId on @api_view endpoints (not null)', async () => {
    const batch = await extract('api-view-functions', 'myapp/views.py');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const e of eps) {
      expect(e.handlerFunctionId).toBeTruthy();
      expect(e.handlerFunctionId).not.toBeNull();
    }
  });

  it('marks evidence.confidence "exact" when the route resolved via URL map', async () => {
    const batch = await extract('api-view-functions', 'myapp/views.py');
    const resolved = endpoints(batch).filter((e) => e.routePattern.startsWith('/api/photos'));
    expect(resolved.length).toBeGreaterThan(0);
    for (const e of resolved) {
      expect(e.evidence?.confidence).toBe('exact');
    }
  });
});
