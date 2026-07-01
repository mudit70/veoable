import { describe, expect, it } from 'vitest';
import { resolveAnchorHref } from '../extract-source-file.js';

/**
 * Unit tests for the `<a href>` resolver in #198 PR3d. Pure function
 * over a single string — no fixtures or AST parse required.
 */

describe('resolveAnchorHref (#198 PR3d)', () => {
  describe('absolute internal paths — emit', () => {
    it('preserves a clean absolute path with trailing slash', () => {
      expect(resolveAnchorHref('/about/')).toBe('/about/');
    });

    it('adds a trailing slash to a path without one', () => {
      expect(resolveAnchorHref('/about')).toBe('/about/');
    });

    it('returns "/" for the root path', () => {
      expect(resolveAnchorHref('/')).toBe('/');
    });

    it('strips a trailing /index.<ext> so it matches PR3a target shape', () => {
      expect(resolveAnchorHref('/about/index.html')).toBe('/about/');
      expect(resolveAnchorHref('/blog/post-1/index.njk')).toBe('/blog/post-1/');
      expect(resolveAnchorHref('/users/index.ejs')).toBe('/users/');
    });

    it('strips query string and fragment', () => {
      expect(resolveAnchorHref('/about/?utm_source=foo')).toBe('/about/');
      expect(resolveAnchorHref('/about#section')).toBe('/about/');
      expect(resolveAnchorHref('/about?q=1#frag')).toBe('/about/');
    });

    it('handles whitespace around the href value', () => {
      expect(resolveAnchorHref('  /about/  ')).toBe('/about/');
    });

    it('does NOT strip /index.tsx (only SSG extensions)', () => {
      // /index.tsx isn't an SSG extension — keep verbatim.
      // The default normalization still adds trailing `/` though.
      expect(resolveAnchorHref('/about/index.tsx')).toBe('/about/index.tsx/');
    });
  });

  describe('external / unresolvable — skip', () => {
    it('skips full URLs', () => {
      expect(resolveAnchorHref('https://example.com/about/')).toBeNull();
      expect(resolveAnchorHref('http://example.com/')).toBeNull();
    });

    it('skips protocol-relative URLs', () => {
      expect(resolveAnchorHref('//cdn.example.com/asset.js')).toBeNull();
    });

    it('skips fragment-only anchors', () => {
      expect(resolveAnchorHref('#section')).toBeNull();
      expect(resolveAnchorHref('#')).toBeNull();
    });

    it('skips mailto / tel / javascript / data URIs', () => {
      expect(resolveAnchorHref('mailto:user@example.com')).toBeNull();
      expect(resolveAnchorHref('tel:+1234567890')).toBeNull();
      expect(resolveAnchorHref('javascript:void(0)')).toBeNull();
      expect(resolveAnchorHref('data:text/plain,hello')).toBeNull();
    });

    it('skips relative paths', () => {
      // Relative resolution requires knowing the current page — out
      // of scope for the conservative first pass.
      expect(resolveAnchorHref('about/')).toBeNull();
      expect(resolveAnchorHref('./about/')).toBeNull();
      expect(resolveAnchorHref('../parent/')).toBeNull();
    });

    it('skips template-tag interpolations', () => {
      // `{{ url }}`, `{% url %}`, etc. — don't try to resolve.
      expect(resolveAnchorHref('{{ url }}')).toBeNull();
      expect(resolveAnchorHref('/{{ slug }}/')).toBeNull();
      expect(resolveAnchorHref('{% url "name" %}')).toBeNull();
    });

    it('skips empty / whitespace-only', () => {
      expect(resolveAnchorHref('')).toBeNull();
      expect(resolveAnchorHref('   ')).toBeNull();
    });

    it('case-insensitively skips MAILTO / Javascript prefixes', () => {
      expect(resolveAnchorHref('MAILTO:foo@bar')).toBeNull();
      expect(resolveAnchorHref('JavaScript:void(0)')).toBeNull();
    });
  });
});
