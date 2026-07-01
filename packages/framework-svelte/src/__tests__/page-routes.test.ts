import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type Screen,
  type SchemaNode,
} from '@adorable/schema';
import { extractSveltePages, findSvelteKitRoutes } from '../page-routes.js';
import { SveltePlugin } from '../svelte-plugin.js';

const FIXTURE = path.resolve(__dirname, '../../../../tests/fixtures/sveltekit-routes');

function screens(batch: { nodes: SchemaNode[] }): Screen[] {
  return batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
}

describe('findSvelteKitRoutes', () => {
  it('finds the root `+page.svelte` at "/"', () => {
    const found = findSvelteKitRoutes(FIXTURE);
    expect(found.find((f) => f.routePath === '/')).toBeDefined();
  });

  it('translates `[id]` to :id', () => {
    const found = findSvelteKitRoutes(FIXTURE);
    expect(found.find((f) => f.routePath === '/users/:id')).toBeDefined();
  });

  it('translates `[...slug]` to :slug*', () => {
    const found = findSvelteKitRoutes(FIXTURE);
    expect(found.find((f) => f.routePath === '/blog/:slug*')).toBeDefined();
  });

  it('omits `(group)` from URL', () => {
    const found = findSvelteKitRoutes(FIXTURE);
    expect(found.find((f) => f.routePath === '/about')).toBeDefined();
    expect(found.find((f) => f.routePath.includes('(marketing)'))).toBeUndefined();
  });

  it('does NOT emit `+layout.svelte` as a Screen', () => {
    const found = findSvelteKitRoutes(FIXTURE);
    for (const f of found) {
      expect(f.filePath).not.toContain('+layout');
    }
  });
});

describe('extractSveltePages', () => {
  it('emits Screens for every discovered SvelteKit page', () => {
    const batch = extractSveltePages(FIXTURE, 'test-repo');
    const paths = screens(batch).map((s) => s.routePath).sort();
    expect(paths).toContain('/');
    expect(paths).toContain('/users/:id');
    expect(paths).toContain('/blog/:slug*');
    expect(paths).toContain('/about');
  });

  it('every emitted Screen passes schema validation', () => {
    const batch = extractSveltePages(FIXTURE, 'test-repo');
    for (const s of screens(batch)) expect(() => validateNode(s)).not.toThrow();
  });

  it('Screens use framework="sveltekit" and navigatorKind="web-router"', () => {
    const batch = extractSveltePages(FIXTURE, 'test-repo');
    for (const s of screens(batch)) {
      expect(s.framework).toBe('sveltekit');
      expect(s.navigatorKind).toBe('web-router');
    }
  });
});

describe('SveltePlugin contract — page emission', () => {
  it('onProjectLoaded returns Screens', () => {
    const p = new SveltePlugin();
    const batch = p.onProjectLoaded({
      rootDir: FIXTURE,
      packageJson: { dependencies: { svelte: '^4.0.0' } },
      files: [],
    });
    expect(screens(batch).length).toBeGreaterThan(0);
  });
});
