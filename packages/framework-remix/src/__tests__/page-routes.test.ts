import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type Screen,
  type SchemaNode,
} from '@adorable/schema';
import { extractRemixPages, findRemixRoutes } from '../page-routes.js';
import { RemixPlugin } from '../remix-plugin.js';

const FIXTURE = path.resolve(__dirname, '../../../../tests/fixtures/remix-routes');

function screens(batch: { nodes: SchemaNode[] }): Screen[] {
  return batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
}

describe('findRemixRoutes', () => {
  it('finds `_index.tsx` at "/"', () => {
    const found = findRemixRoutes(FIXTURE);
    expect(found.find((f) => f.routePath === '/')).toBeDefined();
  });

  it('translates `users.$id.tsx` to /users/:id', () => {
    const found = findRemixRoutes(FIXTURE);
    expect(found.find((f) => f.routePath === '/users/:id')).toBeDefined();
  });

  it('omits `_auth` pathless layout from URL', () => {
    const found = findRemixRoutes(FIXTURE);
    expect(found.find((f) => f.routePath === '/login')).toBeDefined();
    expect(found.find((f) => f.routePath.includes('_auth'))).toBeUndefined();
  });
});

describe('extractRemixPages', () => {
  it('emits a Screen per discovered route file', () => {
    const batch = extractRemixPages(FIXTURE, 'test-repo');
    const paths = screens(batch).map((s) => s.routePath).sort();
    expect(paths).toContain('/');
    expect(paths).toContain('/users/:id');
    expect(paths).toContain('/login');
  });

  it('every emitted Screen passes schema validation', () => {
    const batch = extractRemixPages(FIXTURE, 'test-repo');
    for (const s of screens(batch)) expect(() => validateNode(s)).not.toThrow();
  });

  it('Screens use framework="remix" and navigatorKind="web-router"', () => {
    const batch = extractRemixPages(FIXTURE, 'test-repo');
    for (const s of screens(batch)) {
      expect(s.framework).toBe('remix');
      expect(s.navigatorKind).toBe('web-router');
    }
  });
});

describe('RemixPlugin contract — page emission', () => {
  it('onProjectLoaded returns Screens', () => {
    const p = new RemixPlugin();
    const batch = p.onProjectLoaded({
      rootDir: FIXTURE,
      packageJson: { dependencies: { '@remix-run/react': '^2.0.0' } },
      files: [],
    });
    expect(screens(batch).length).toBeGreaterThan(0);
  });
});
