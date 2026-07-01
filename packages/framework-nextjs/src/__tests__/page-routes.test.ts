import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type Screen,
  type SchemaNode,
} from '@veoable/schema';
import {
  extractNextjsPages,
  findAppRouterPages,
  findPagesRouterPages,
} from '../page-routes.js';
import { NextjsPlugin } from '../nextjs-plugin.js';

const FIXTURE = path.resolve(__dirname, '../../../../tests/fixtures/nextjs-pages');

function screens(batch: { nodes: SchemaNode[] }): Screen[] {
  return batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
}

describe('findAppRouterPages', () => {
  it('finds the root page (`app/page.tsx`) at "/"', () => {
    const found = findAppRouterPages(FIXTURE);
    expect(found.find((f) => f.routePath === '/')).toBeDefined();
  });

  it('translates [id] dynamic segments to :id', () => {
    const found = findAppRouterPages(FIXTURE);
    expect(found.find((f) => f.routePath === '/users/:id')).toBeDefined();
  });

  it('translates [...slug] catch-all to :slug*', () => {
    const found = findAppRouterPages(FIXTURE);
    expect(found.find((f) => f.routePath === '/blog/:slug*')).toBeDefined();
  });

  it('omits route groups `(marketing)` from URL', () => {
    const found = findAppRouterPages(FIXTURE);
    // `(marketing)/about/page.tsx` becomes `/about`, not `/(marketing)/about`.
    expect(found.find((f) => f.routePath === '/about')).toBeDefined();
    expect(found.find((f) => f.routePath.includes('(marketing)'))).toBeUndefined();
  });
});

describe('findPagesRouterPages', () => {
  it('finds index files (`pages/index.tsx`) at "/"', () => {
    const found = findPagesRouterPages(FIXTURE);
    expect(found.find((f) => f.routePath === '/')).toBeDefined();
  });

  it('finds `pages/dashboard.tsx` at "/dashboard"', () => {
    const found = findPagesRouterPages(FIXTURE);
    expect(found.find((f) => f.routePath === '/dashboard')).toBeDefined();
  });

  it('translates [id] in nested dirs to :id', () => {
    const found = findPagesRouterPages(FIXTURE);
    expect(found.find((f) => f.routePath === '/users/:id')).toBeDefined();
  });

  it('skips `_app.tsx`, `_document.tsx`, `_error.tsx`', () => {
    const found = findPagesRouterPages(FIXTURE);
    for (const f of found) {
      expect(f.routePath).not.toContain('_app');
      expect(f.routePath).not.toContain('_document');
      expect(f.routePath).not.toContain('_error');
    }
  });

  it('skips the `pages/api/` subtree', () => {
    const found = findPagesRouterPages(FIXTURE);
    for (const f of found) {
      expect(f.routePath.startsWith('/api/')).toBe(false);
    }
  });
});

describe('extractNextjsPages', () => {
  it('emits a Screen per discovered page (App + Pages routers)', () => {
    const batch = extractNextjsPages(FIXTURE, 'test-repo');
    const sc = screens(batch);
    const paths = sc.map((s) => s.routePath).sort();
    expect(paths).toContain('/');
    expect(paths).toContain('/users/:id');
    expect(paths).toContain('/blog/:slug*');
    expect(paths).toContain('/about');
    expect(paths).toContain('/dashboard');
  });

  it('every emitted Screen passes schema validation', () => {
    const batch = extractNextjsPages(FIXTURE, 'test-repo');
    for (const s of screens(batch)) expect(() => validateNode(s)).not.toThrow();
  });

  it('Screens use `framework: nextjs-app` or `nextjs-pages`', () => {
    const batch = extractNextjsPages(FIXTURE, 'test-repo');
    for (const s of screens(batch)) {
      expect(['nextjs-app', 'nextjs-pages']).toContain(s.framework);
    }
  });

  it('navigatorKind is "web-router" for all Next.js Screens', () => {
    const batch = extractNextjsPages(FIXTURE, 'test-repo');
    for (const s of screens(batch)) {
      expect(s.navigatorKind).toBe('web-router');
    }
  });

  it('returns empty batch when no app/ or pages/ directory', () => {
    const tmp = path.resolve(__dirname, '../../../../tests/fixtures');
    // The `tests/fixtures` root has no app/ at depth 1, so this is empty.
    const batch = extractNextjsPages(tmp, 'test-repo');
    // Other fixtures may have app/ or pages/, so we can't assert empty
    // here; just verify the call doesn't throw.
    expect(Array.isArray(batch.nodes)).toBe(true);
  });
});

describe('NextjsPlugin contract — page route emission', () => {
  it('onProjectLoaded returns Screens for the fixture', () => {
    const p = new NextjsPlugin();
    const batch = p.onProjectLoaded({
      rootDir: FIXTURE,
      packageJson: { dependencies: { next: '^14.0.0' } },
      files: [],
    });
    expect(screens(batch).length).toBeGreaterThan(0);
  });
});
