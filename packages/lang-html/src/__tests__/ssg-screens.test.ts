import { describe, expect, it } from 'vitest';
import { deriveSsgScreenRoute } from '../extract-source-file.js';

/**
 * Unit tests for the SSG Screen route derivation introduced in
 * #198 PR3a. The helper is a pure function over a path string —
 * tests don't need fixtures or a tree-sitter parse.
 */

describe('deriveSsgScreenRoute (#198 PR3a)', () => {
  it('emits a Screen for an index.html at the recognized site root', () => {
    expect(deriveSsgScreenRoute('static-site/about/index.html')).toEqual({
      routePath: '/about/',
      name: '/about/',
    });
  });

  it('emits a Screen for an index.njk under site-files-src/', () => {
    expect(deriveSsgScreenRoute('site-files-src/blog/post-1/index.njk')).toEqual({
      routePath: '/blog/post-1/',
      name: '/blog/post-1/',
    });
  });

  it('iteratively strips multiple recognized prefixes (static-site/site-files-src/...)', () => {
    expect(
      deriveSsgScreenRoute('static-site/site-files-src/landing/index.njk')
    ).toEqual({
      routePath: '/landing/',
      name: '/landing/',
    });
  });

  it('strips pages/ + sub-directory traversal correctly', () => {
    expect(deriveSsgScreenRoute('pages/users/profile/index.html')).toEqual({
      routePath: '/users/profile/',
      name: '/users/profile/',
    });
  });

  it('returns "/" for a root index file (filename only, no dir)', () => {
    expect(deriveSsgScreenRoute('index.html')).toEqual({
      routePath: '/',
      name: '/',
    });
  });

  it('returns "/" for index.njk at a recognized site root with no path beyond it', () => {
    expect(deriveSsgScreenRoute('site-files-src/index.njk')).toEqual({
      routePath: '/',
      name: '/',
    });
  });

  it('keeps unrecognized directories verbatim in the routePath', () => {
    // Conservative — anything not in the SSG_SOURCE_PREFIXES list
    // shows up in the routePath. The user can apply stitch rules.
    expect(deriveSsgScreenRoute('weird/path/with/index.html')).toEqual({
      routePath: '/weird/path/with/',
      name: '/weird/path/with/',
    });
  });

  it('returns null for non-index files (about-me.html style)', () => {
    expect(deriveSsgScreenRoute('static-site/about-me.html')).toBeNull();
    expect(deriveSsgScreenRoute('pages/users.njk')).toBeNull();
  });

  it('returns null for unrecognized extensions even at index.<ext>', () => {
    // .vue is intentionally excluded — Vue SFCs are SPA components.
    expect(deriveSsgScreenRoute('pages/about/index.vue')).toBeNull();
    expect(deriveSsgScreenRoute('pages/about/index.tsx')).toBeNull();
    expect(deriveSsgScreenRoute('pages/about/index.md')).toBeNull();
  });

  it('handles every recognized SSG extension', () => {
    const extensions = [
      'html', 'htm', 'njk', 'ejs', 'hbs', 'handlebars',
      'j2', 'jinja', 'jinja2', 'twig', 'liquid', 'mustache',
    ];
    for (const ext of extensions) {
      const r = deriveSsgScreenRoute(`pages/about/index.${ext}`);
      expect(r, `extension .${ext} should produce a Screen`).not.toBeNull();
      expect(r!.routePath).toBe('/about/');
    }
  });

  it('is case-insensitive on the filename + extension', () => {
    expect(deriveSsgScreenRoute('static-site/about/INDEX.HTML')).toEqual({
      routePath: '/about/',
      name: '/about/',
    });
  });

  // Vendor / build-output filter — `index.html` files in dependency
  // snapshots or generated build artifacts are NOT routes. Without
  // this filter, projects that ship `node_modules/` or `dist/` would
  // get phantom Screens.
  it('returns null for index.html inside node_modules/', () => {
    expect(deriveSsgScreenRoute('node_modules/some-pkg/index.html')).toBeNull();
    expect(deriveSsgScreenRoute('packages/x/node_modules/foo/index.html')).toBeNull();
  });

  it('returns null for index.html inside .next/, .nuxt/, .svelte-kit/, .output/', () => {
    expect(deriveSsgScreenRoute('.next/static/index.html')).toBeNull();
    expect(deriveSsgScreenRoute('.nuxt/dist/index.html')).toBeNull();
    expect(deriveSsgScreenRoute('.svelte-kit/output/index.html')).toBeNull();
    expect(deriveSsgScreenRoute('.output/public/index.html')).toBeNull();
  });

  it('returns null for index.html inside coverage/ or storybook-static/', () => {
    expect(deriveSsgScreenRoute('coverage/lcov-report/index.html')).toBeNull();
    expect(deriveSsgScreenRoute('storybook-static/index.html')).toBeNull();
  });

  it('all recognized SSG prefixes are eventually stripped', () => {
    const prefixes = [
      'static-site-template/', 'static-site/',
      'site-files-src/', 'site-files/',
      'src/pages/', 'src/views/', 'src/templates/',
      'pages/', 'views/', 'templates/',
      '_site/', 'site/',
      'public/', 'static/', 'dist/', 'build/',
      'src/',
    ];
    for (const prefix of prefixes) {
      const r = deriveSsgScreenRoute(`${prefix}about/index.html`);
      expect(r?.routePath, `prefix ${prefix} should be stripped`).toBe('/about/');
    }
  });

  it('is deterministic across repeated calls (pure)', () => {
    const a = deriveSsgScreenRoute('site-files-src/blog/post-1/index.njk');
    const b = deriveSsgScreenRoute('site-files-src/blog/post-1/index.njk');
    expect(a).toEqual(b);
  });
});
