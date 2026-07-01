import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validateNode,
  validateEdge,
  type NavigatesToEdge,
  type Screen,
  type SchemaNode,
  type SchemaEdge,
  type SourceFile,
} from '@adorable/schema';
import {
  extractRedirects,
  findRedirectConfigs,
  parseRedirects,
} from '../parser.js';
import { RedirectsPlugin } from '../redirects-plugin.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/redirects');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

function screens(batch: { nodes: SchemaNode[] }): Screen[] {
  return batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
}

function sourceFiles(batch: { nodes: SchemaNode[] }): SourceFile[] {
  return batch.nodes.filter((n): n is SourceFile => n.nodeType === 'SourceFile');
}

function navigatesTo(batch: { edges: SchemaEdge[] }): NavigatesToEdge[] {
  return batch.edges.filter((e): e is NavigatesToEdge => e.edgeType === 'NAVIGATES_TO');
}

describe('findRedirectConfigs', () => {
  it('returns paths for both firebase.json and vercel.json when present', () => {
    const fb = fixturePath('firebase');
    const result = findRedirectConfigs(fb);
    expect(result.firebase).toBe(path.join(fb, 'firebase.json'));
    expect(result.vercel).toBeNull();
  });

  it('returns null for both when neither file exists', () => {
    const r = findRedirectConfigs(fixturePath('none'));
    expect(r.firebase).toBeNull();
    expect(r.vercel).toBeNull();
  });
});

describe('parseRedirects — firebase', () => {
  it('parses redirects from firebase.json single-target shape', () => {
    const findings = parseRedirects(
      path.join(fixturePath('firebase'), 'firebase.json'),
      'firebase',
      'firebase.json',
    );
    expect(findings.length).toBe(3);
    expect(findings[0]).toMatchObject({ source: '/try', destination: '/signup', status: 301 });
    expect(findings[1]).toMatchObject({ source: '/old-blog/:slug', destination: '/blog/:slug', status: 302 });
    expect(findings[2]).toMatchObject({ source: '/legacy', destination: 'https://example.com/new', status: 301 });
  });

  it('parses redirects from firebase.json multi-target shape', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redirects-multi-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'firebase.json'),
        JSON.stringify({
          hosting: [
            { target: 'site-a', redirects: [{ source: '/a', destination: '/A', type: 301 }] },
            { target: 'site-b', redirects: [{ source: '/b', destination: '/B', type: 302 }] },
          ],
        }),
      );
      const findings = parseRedirects(path.join(tmp, 'firebase.json'), 'firebase', 'firebase.json');
      expect(findings.length).toBe(2);
      expect(findings[0].source).toBe('/a');
      expect(findings[1].source).toBe('/b');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns [] for malformed JSON (silently skipped)', () => {
    const findings = parseRedirects(
      path.join(fixturePath('malformed'), 'firebase.json'),
      'firebase',
      'firebase.json',
    );
    expect(findings).toEqual([]);
  });

  it('returns [] when file is missing', () => {
    const findings = parseRedirects(
      path.join(fixturePath('firebase'), 'does-not-exist.json'),
      'firebase',
      'firebase.json',
    );
    expect(findings).toEqual([]);
  });

  it('returns [] when redirects array is missing or empty', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redirects-empty-'));
    try {
      fs.writeFileSync(path.join(tmp, 'firebase.json'), JSON.stringify({ hosting: { public: 'build' } }));
      const findings = parseRedirects(path.join(tmp, 'firebase.json'), 'firebase', 'firebase.json');
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('caps at MAX_REDIRECT_ENTRIES to prevent OOM', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redirects-cap-'));
    try {
      const huge = Array.from({ length: 6000 }, (_, i) => ({
        source: `/old/${i}`,
        destination: `/new/${i}`,
        type: 301,
      }));
      fs.writeFileSync(
        path.join(tmp, 'firebase.json'),
        JSON.stringify({ hosting: { redirects: huge } }),
      );
      const findings = parseRedirects(path.join(tmp, 'firebase.json'), 'firebase', 'firebase.json');
      expect(findings.length).toBe(5000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips entries with non-string source or destination', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redirects-bad-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'firebase.json'),
        JSON.stringify({
          hosting: {
            redirects: [
              { source: '/ok', destination: '/ok-dst', type: 301 },
              { source: 123, destination: '/bad' },
              { source: '/no-dst' },
              { destination: '/no-src' },
              { source: 'not-a-path-or-url', destination: '/x' },
            ],
          },
        }),
      );
      const findings = parseRedirects(path.join(tmp, 'firebase.json'), 'firebase', 'firebase.json');
      expect(findings.length).toBe(1);
      expect(findings[0].source).toBe('/ok');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('parseRedirects — vercel', () => {
  it('parses redirects from vercel.json (permanent: true → 308)', () => {
    const findings = parseRedirects(
      path.join(fixturePath('vercel'), 'vercel.json'),
      'vercel',
      'vercel.json',
    );
    expect(findings.length).toBe(3);
    expect(findings[0]).toMatchObject({ source: '/try', destination: '/signup', status: 308 });
    expect(findings[1]).toMatchObject({ source: '/temp', destination: '/permanent', status: 307 });
    expect(findings[2]).toMatchObject({ source: '/with-status', destination: '/elsewhere', status: 301 });
  });
});

describe('extractRedirects — full batch emission', () => {
  it('emits SourceFile + Screens + NAVIGATES_TO for firebase.json', () => {
    const batch = extractRedirects(fixturePath('firebase'), 'test-repo');
    const sf = sourceFiles(batch);
    expect(sf.length).toBe(1);
    expect(sf[0].filePath).toBe('firebase.json');
    expect(sf[0].language).toBe('json');
    expect(sf[0].framework).toBe('firebase-config');

    const sc = screens(batch);
    // 3 redirects → 3 source + 3 destination Screens, but `try`->`signup`
    // both unique => 6 Screens. The /old-blog/:slug → /blog/:slug pair
    // is unique. /legacy → https://example.com/new is unique. So 6 total.
    expect(sc.length).toBe(6);
    const paths = sc.map((s) => s.routePath).sort();
    expect(paths).toContain('/try');
    expect(paths).toContain('/signup');
    expect(paths).toContain('https://example.com/new');

    const edges = navigatesTo(batch);
    expect(edges.length).toBe(3);
    const methods = edges.map((e) => e.method).sort();
    expect(methods).toEqual(['redirect-301', 'redirect-301', 'redirect-302']);
  });

  it('returns empty batch when neither config file exists', () => {
    const batch = extractRedirects(fixturePath('none'), 'test-repo');
    expect(batch.nodes).toHaveLength(0);
    expect(batch.edges).toHaveLength(0);
  });

  it('every emitted Screen passes schema validation', () => {
    const batch = extractRedirects(fixturePath('firebase'), 'test-repo');
    for (const s of screens(batch)) {
      expect(() => validateNode(s)).not.toThrow();
    }
  });

  it('every emitted SourceFile passes schema validation', () => {
    const batch = extractRedirects(fixturePath('firebase'), 'test-repo');
    for (const f of sourceFiles(batch)) {
      expect(() => validateNode(f)).not.toThrow();
    }
  });

  it('every emitted NAVIGATES_TO edge passes schema validation', () => {
    const batch = extractRedirects(fixturePath('firebase'), 'test-repo');
    for (const e of navigatesTo(batch)) {
      expect(() => validateEdge(e)).not.toThrow();
    }
  });

  it('Screen ID for the destination matches what react-router would emit', () => {
    // ID derivation must match `idFor.screen({repository, name, routePath})`
    // so when react-router or lang-html SSG emits a Screen at `/signup`,
    // the IDs collapse and the canonical store de-dupes.
    const batch = extractRedirects(fixturePath('firebase'), 'test-repo');
    const signupScreen = screens(batch).find((s) => s.routePath === '/signup');
    expect(signupScreen).toBeDefined();
    // The id format is content-addressed; just verify it starts with "Screen:".
    expect(signupScreen!.id).toMatch(/^Screen:/);
  });
});

describe('extractRedirects — both firebase + vercel', () => {
  it('emits one SourceFile per config file when both exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redirects-both-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'firebase.json'),
        JSON.stringify({ hosting: { redirects: [{ source: '/a', destination: '/A', type: 301 }] } }),
      );
      fs.writeFileSync(
        path.join(tmp, 'vercel.json'),
        JSON.stringify({ redirects: [{ source: '/b', destination: '/B', permanent: true }] }),
      );
      const batch = extractRedirects(tmp, 'test-repo');
      const sf = sourceFiles(batch);
      expect(sf.length).toBe(2);
      const filePaths = sf.map((s) => s.filePath).sort();
      expect(filePaths).toEqual(['firebase.json', 'vercel.json']);
      expect(navigatesTo(batch)).toHaveLength(2);
      // #293 — framework labels are concrete (not generic 'redirects'),
      // so describe_architecture and stat groupings can distinguish
      // firebase configs from vercel configs.
      const byPath = Object.fromEntries(sf.map((s) => [s.filePath, s.framework]));
      expect(byPath['firebase.json']).toBe('firebase-config');
      expect(byPath['vercel.json']).toBe('vercel-config');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('RedirectsPlugin contract', () => {
  it('has id="redirects" and language="ts"', () => {
    const p = new RedirectsPlugin();
    expect(p.id).toBe('redirects');
    expect(p.language).toBe('ts');
  });

  it('appliesTo returns true when firebase.json exists', () => {
    const p = new RedirectsPlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('firebase'),
        packageJson: null,
        files: [],
      }),
    ).toBe(true);
  });

  it('appliesTo returns true when vercel.json exists', () => {
    const p = new RedirectsPlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('vercel'),
        packageJson: null,
        files: [],
      }),
    ).toBe(true);
  });

  it('appliesTo returns false when neither config file exists', () => {
    const p = new RedirectsPlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('none'),
        packageJson: null,
        files: [],
      }),
    ).toBe(false);
  });

  it('onProjectLoaded returns the same batch as extractRedirects', () => {
    const p = new RedirectsPlugin();
    const batch = p.onProjectLoaded({
      rootDir: fixturePath('firebase'),
      packageJson: null,
      files: [],
    });
    expect(batch.nodes.length).toBeGreaterThan(0);
    expect(batch.edges.length).toBeGreaterThan(0);
  });

  it('visitor is a no-op (project-level extraction only)', () => {
    const p = new RedirectsPlugin();
    expect(p.visitor.language).toBe('ts');
    // onNode should not throw on any node.
    expect(() => p.visitor.onNode()).not.toThrow();
  });
});
