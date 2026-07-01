import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Screen } from '@veoable/schema';
import { findNuxtPages, extractNuxtScreens, VuePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/nuxt');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

describe('findNuxtPages', () => {
  it('finds every page under pages/ and converts file paths to URL patterns', () => {
    const pages = findNuxtPages(fixturePath('basic'));
    const routes = pages.map((p) => p.routePath).sort();
    // index.vue → /, about.vue → /about, users/[id].vue → /users/:id,
    // users/[...slug].vue → /users/:slug*, (auth)/login.vue → /login.
    expect(routes).toEqual(['/', '/about', '/login', '/users/:id', '/users/:slug*']);
  });

  it('returns the relative file path with POSIX separators', () => {
    const pages = findNuxtPages(fixturePath('basic'));
    const userById = pages.find((p) => p.routePath === '/users/:id');
    expect(userById).toBeDefined();
    expect(userById!.filePath).toBe('pages/users/[id].vue');
  });

  it('emits empty list when pages/ does not exist', () => {
    const tmp = path.join(__dirname, '__nonexistent__');
    expect(findNuxtPages(tmp)).toEqual([]);
  });
});

describe('extractNuxtScreens', () => {
  it('emits one Screen node per page with framework="nuxt"', () => {
    const batch = extractNuxtScreens(fixturePath('basic'), 'repo');
    const screens = batch.nodes.filter(
      (n): n is Screen => n.nodeType === 'Screen',
    );
    expect(screens).toHaveLength(5);
    for (const s of screens) {
      expect(s.framework).toBe('nuxt');
      expect(s.repository).toBe('repo');
      expect(s.navigatorKind).toBe('web-router');
    }
  });

  it('deduplicates by content-addressed id', () => {
    // Running twice on the same root yields the same set of ids;
    // we just confirm uniqueness within one batch.
    const batch = extractNuxtScreens(fixturePath('basic'), 'repo');
    const ids = batch.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('VuePlugin.onProjectLoaded', () => {
  it('emits Nuxt Screens when nuxt is in dependencies', () => {
    const plugin = new VuePlugin();
    const batch = plugin.onProjectLoaded({
      rootDir: fixturePath('basic'),
      packageJson: { dependencies: { nuxt: '^3.0.0', vue: '^3.0.0' } },
      files: [],
    });
    expect(batch.nodes.filter((n) => n.nodeType === 'Screen')).toHaveLength(5);
  });

  it('returns empty batch when nuxt is NOT a dependency (plain Vue SPA)', () => {
    const plugin = new VuePlugin();
    const batch = plugin.onProjectLoaded({
      rootDir: fixturePath('basic'),
      packageJson: { dependencies: { vue: '^3.0.0' } },
      files: [],
    });
    // Plain Vue → no file-based router convention; skip extraction.
    expect(batch.nodes).toHaveLength(0);
    expect(batch.edges).toHaveLength(0);
  });
});

describe('VuePlugin.appliesTo', () => {
  it('activates when nuxt is a dependency (even without vue listed)', () => {
    const plugin = new VuePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { nuxt: '^3.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('still activates when vue is a dependency (no nuxt)', () => {
    const plugin = new VuePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { vue: '^3.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });
});
