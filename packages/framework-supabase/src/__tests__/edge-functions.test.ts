import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type APIEndpoint,
  type SchemaNode,
  type SourceFile,
} from '@adorable/schema';
import {
  edgeFunctionRoutePattern,
  extractEdgeFunctions,
  findEdgeFunctions,
} from '../edge-functions.js';
import { SupabasePlugin } from '../supabase-plugin.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/supabase');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}
function sourceFiles(batch: { nodes: SchemaNode[] }): SourceFile[] {
  return batch.nodes.filter((n): n is SourceFile => n.nodeType === 'SourceFile');
}

describe('findEdgeFunctions', () => {
  it('finds canonical supabase/functions/<name>/index.ts directories', () => {
    const found = findEdgeFunctions(fixturePath('with-functions'));
    const names = found.map((f) => f.name).sort();
    expect(names).toEqual(['billing-webhook', 'hello']);
  });

  it('skips _shared and other underscore/dot-prefixed directories', () => {
    const found = findEdgeFunctions(fixturePath('with-functions'));
    const names = found.map((f) => f.name);
    expect(names).not.toContain('_shared');
  });

  it('returns [] when supabase/functions/ is missing', () => {
    expect(findEdgeFunctions(fixturePath('no-functions'))).toEqual([]);
  });

  it('returns [] when supabase/ exists but functions/ is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-no-fn-'));
    try {
      fs.mkdirSync(path.join(tmp, 'supabase', 'migrations'), { recursive: true });
      expect(findEdgeFunctions(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('matches .ts, .tsx, .js, .mjs index files (canonical Deno layouts)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-ext-'));
    try {
      const fns = path.join(tmp, 'supabase', 'functions');
      fs.mkdirSync(path.join(fns, 'a'), { recursive: true });
      fs.mkdirSync(path.join(fns, 'b'), { recursive: true });
      fs.mkdirSync(path.join(fns, 'c'), { recursive: true });
      fs.mkdirSync(path.join(fns, 'd'), { recursive: true });
      fs.writeFileSync(path.join(fns, 'a', 'index.ts'), '');
      fs.writeFileSync(path.join(fns, 'b', 'index.tsx'), '');
      fs.writeFileSync(path.join(fns, 'c', 'index.js'), '');
      fs.writeFileSync(path.join(fns, 'd', 'index.mjs'), '');
      const names = findEdgeFunctions(tmp).map((f) => f.name).sort();
      expect(names).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips function dirs without an index file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-noindex-'));
    try {
      const fns = path.join(tmp, 'supabase', 'functions');
      fs.mkdirSync(path.join(fns, 'broken'), { recursive: true });
      // No index file inside.
      expect(findEdgeFunctions(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('edgeFunctionRoutePattern', () => {
  it('produces the canonical Supabase Edge URL', () => {
    expect(edgeFunctionRoutePattern('hello')).toBe('/functions/v1/hello');
    expect(edgeFunctionRoutePattern('billing-webhook')).toBe('/functions/v1/billing-webhook');
  });
});

describe('extractEdgeFunctions', () => {
  it('emits SourceFile + APIEndpoint per function', () => {
    const batch = extractEdgeFunctions(fixturePath('with-functions'), 'test-repo');
    expect(sourceFiles(batch).length).toBe(2);
    expect(endpoints(batch).length).toBe(2);
  });

  it('emits APIEndpoints with httpMethod=POST and routePattern=/functions/v1/<name>', () => {
    const batch = extractEdgeFunctions(fixturePath('with-functions'), 'test-repo');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => e.routePattern).sort();
    expect(patterns).toEqual(['/functions/v1/billing-webhook', '/functions/v1/hello']);
    for (const ep of eps) {
      expect(ep.httpMethod).toBe('POST');
      expect(ep.framework).toBe('supabase-edge');
      expect(ep.handlerFunctionId).toBeNull();
    }
  });

  it('every emitted node passes schema validation', () => {
    const batch = extractEdgeFunctions(fixturePath('with-functions'), 'test-repo');
    for (const n of batch.nodes) {
      expect(() => validateNode(n)).not.toThrow();
    }
  });

  it('returns empty batch when no supabase/functions/ exists', () => {
    const batch = extractEdgeFunctions(fixturePath('no-functions'), 'test-repo');
    expect(batch.nodes).toHaveLength(0);
    expect(batch.edges).toHaveLength(0);
  });

  it('SourceFile.filePath uses POSIX separators (forward slashes)', () => {
    const batch = extractEdgeFunctions(fixturePath('with-functions'), 'test-repo');
    for (const sf of sourceFiles(batch)) {
      expect(sf.filePath).not.toContain('\\');
      expect(sf.filePath).toMatch(/^supabase\/functions\/[^/]+\/index\./);
    }
  });
});

describe('SupabasePlugin contract — Edge Functions integration', () => {
  it('appliesTo returns true when @supabase/supabase-js is in deps', () => {
    const p = new SupabasePlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('no-functions'),
        packageJson: { dependencies: { '@supabase/supabase-js': '^2.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('appliesTo returns true when supabase/functions/ exists, even without SDK in deps', () => {
    const p = new SupabasePlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('with-functions'),
        packageJson: null,
        files: [],
      }),
    ).toBe(true);
  });

  it('appliesTo returns false when neither signal is present', () => {
    const p = new SupabasePlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('no-functions'),
        packageJson: { dependencies: {} },
        files: [],
      }),
    ).toBe(false);
  });

  it('onProjectLoaded emits DatabaseSystem + Edge Function endpoints', () => {
    const p = new SupabasePlugin();
    const batch = p.onProjectLoaded({
      rootDir: fixturePath('with-functions'),
      packageJson: { dependencies: { '@supabase/supabase-js': '^2.0.0' } },
      files: [],
    });
    // 1 DatabaseSystem + 2 SourceFiles + 2 APIEndpoints = 5.
    expect(batch.nodes.length).toBe(5);
    expect(batch.nodes.find((n) => n.nodeType === 'DatabaseSystem')).toBeDefined();
    expect(endpoints(batch).length).toBe(2);
  });
});
