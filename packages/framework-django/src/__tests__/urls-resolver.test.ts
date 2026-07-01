import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDjangoUrlMap } from '../urls-resolver.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/python/django');

describe('buildDjangoUrlMap', () => {
  it('returns empty map when no urls.py exists', () => {
    const m = buildDjangoUrlMap(path.join(FIXTURE_ROOT, 'basic'));
    expect(m.viewSetPrefix.size).toBe(0);
  });

  it("composes path('api/v2/', include('myapp.urls')) + router.register(r'articles', ArticleViewSet)", () => {
    const m = buildDjangoUrlMap(path.join(FIXTURE_ROOT, 'with-urls'));
    expect(m.viewSetPrefix.get('ArticleViewSet')).toBe('/api/v2/articles');
  });

  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'django-urls-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('handles multi-include chain — two apps mounted at different prefixes', () => {
    fs.mkdirSync(path.join(tmp, 'app1'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'app2'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'app1', 'urls.py'),
      `from rest_framework.routers import DefaultRouter\nrouter = DefaultRouter()\nrouter.register(r'users', UserViewSet)\n`,
    );
    fs.writeFileSync(
      path.join(tmp, 'app2', 'urls.py'),
      `from rest_framework.routers import DefaultRouter\nrouter = DefaultRouter()\nrouter.register(r'orders', OrderViewSet)\n`,
    );
    fs.writeFileSync(
      path.join(tmp, 'project', 'urls.py'),
      `from django.urls import path, include\nurlpatterns = [\n  path('api/v1/', include('app1.urls')),\n  path('api/v2/', include('app2.urls')),\n]\n`,
    );
    const m = buildDjangoUrlMap(tmp);
    expect(m.viewSetPrefix.get('UserViewSet')).toBe('/api/v1/users');
    expect(m.viewSetPrefix.get('OrderViewSet')).toBe('/api/v2/orders');
  });

  it('handles router-only (no include() chain) — prefix is just the resource', () => {
    fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'project', 'urls.py'),
      `from rest_framework.routers import DefaultRouter\nrouter = DefaultRouter()\nrouter.register(r'tags', TagViewSet)\n`,
    );
    const m = buildDjangoUrlMap(tmp);
    expect(m.viewSetPrefix.get('TagViewSet')).toBe('/tags');
  });

  it('handles router.register(r"articles", ArticleViewSet, basename="...")', () => {
    fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'project', 'urls.py'),
      `router.register(r'articles', ArticleViewSet, basename='custom')\n`,
    );
    const m = buildDjangoUrlMap(tmp);
    expect(m.viewSetPrefix.get('ArticleViewSet')).toBe('/articles');
  });
});

// #524 — re_path() with regex anchors and the trailing-slash
// composition edge case.
describe('re_path() anchor stripping + trailing-slash composition (#524)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'django-url-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('strips ^ and $ anchors from re_path(r"^api/photos/$", ...)', () => {
    fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'project', 'urls.py'),
      `from django.urls import re_path
urlpatterns = [re_path(r'^api/photos/$', views.list_photos)]
`,
    );
    const m = buildDjangoUrlMap(tmp);
    // Without the anchor strip this would be '/^api/photos/$' — useless
    // for stitcher matching. After the fix it's a clean '/api/photos/'.
    expect(m.functionRoute.get('list_photos')).toBe('/api/photos/');
  });

  it('strips \\A and \\Z anchors too', () => {
    fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'project', 'urls.py'),
      `from django.urls import re_path
urlpatterns = [re_path(r'\\Aapi/photos\\Z', views.list_photos)]
`,
    );
    const m = buildDjangoUrlMap(tmp);
    expect(m.functionRoute.get('list_photos')).toBe('/api/photos');
  });

  it('preserves trailing slash when subPath is exactly "/"', () => {
    // Verified through include() chain: composeFunctionRoute is
    // exercised end-to-end here. With `prefix="api/"` and an
    // empty-path mapping `path("/", views.root)`, the composed
    // route should be `/api/` — not `/api`.
    fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'project', 'urls.py'),
      `from django.urls import include, path
urlpatterns = [path('api/', include('myapp.urls'))]
`,
    );
    fs.mkdirSync(path.join(tmp, 'myapp'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'myapp', 'urls.py'),
      `from django.urls import path
urlpatterns = [path('/', views.root)]
`,
    );
    const m = buildDjangoUrlMap(tmp);
    expect(m.functionRoute.get('root')).toBe('/api/');
  });
});
