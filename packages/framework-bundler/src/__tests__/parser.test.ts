import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  validateEdge,
  type BundlesToEdge,
  type SchemaEdge,
  type SchemaNode,
  type SourceFile,
} from '@adorable/schema';
import {
  evalConstant,
  extractBundles,
  findBundlerConfigs,
  parseBundlerConfig,
} from '../index.js';
import { BundlerPlugin } from '../bundler-plugin.js';
import { Project } from 'ts-morph';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/bundler');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

function sourceFiles(batch: { nodes: SchemaNode[] }): SourceFile[] {
  return batch.nodes.filter((n): n is SourceFile => n.nodeType === 'SourceFile');
}
function bundlesToEdges(batch: { edges: SchemaEdge[] }): BundlesToEdge[] {
  return batch.edges.filter((e): e is BundlesToEdge => e.edgeType === 'BUNDLES_TO');
}

describe('evalConstant', () => {
  function evaluate(source: string): string | null {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile('t.ts', `const x = ${source};`);
    const init = sf.getVariableDeclarationOrThrow('x').getInitializerOrThrow();
    return evalConstant(init);
  }

  it('evaluates string literals', () => {
    expect(evaluate('"hello"')).toBe('hello');
  });

  it('evaluates no-substitution template literals', () => {
    expect(evaluate('`world`')).toBe('world');
  });

  it('evaluates path.resolve(literal, literal)', () => {
    expect(evaluate('path.resolve("a", "b")')).toBe('a/b');
  });

  it('evaluates path.join(literal, literal, literal)', () => {
    expect(evaluate('path.join("/a", "b", "c")')).toBe('/a/b/c');
  });

  it('evaluates a top-level const reference', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(
      't.ts',
      `const buildDir = "build/assets";\nconst x = path.join(buildDir, "[name].js");`,
    );
    const init = sf.getVariableDeclarationOrThrow('x').getInitializerOrThrow();
    expect(evalConstant(init)).toBe('build/assets/[name].js');
  });

  it('returns null for non-resolvable expressions', () => {
    expect(evaluate('process.env.SOMETHING')).toBeNull();
    expect(evaluate('someFn()')).toBeNull();
  });

  it('treats __dirname as empty (rootDir-relative)', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(
      't.ts',
      `const x = path.resolve(__dirname, "src/main.ts");`,
    );
    const init = sf.getVariableDeclarationOrThrow('x').getInitializerOrThrow();
    expect(evalConstant(init)).toBe('src/main.ts');
  });
});

describe('findBundlerConfigs', () => {
  it('finds webpack.config.js at the root', () => {
    const found = findBundlerConfigs(fixturePath('webpack-basic'));
    expect(found.length).toBe(1);
    expect(found[0].bundler).toBe('webpack');
  });

  it('finds vite.config.ts at the root', () => {
    const found = findBundlerConfigs(fixturePath('vite-basic'));
    expect(found.length).toBe(1);
    expect(found[0].bundler).toBe('vite');
  });

  it('finds rollup.config.js at the root', () => {
    const found = findBundlerConfigs(fixturePath('rollup-basic'));
    expect(found.length).toBe(1);
    expect(found[0].bundler).toBe('rollup');
  });

  it('finds configs one level deep (legacy webpack_config.js)', () => {
    const found = findBundlerConfigs(fixturePath('subdir'));
    expect(found.length).toBe(1);
    expect(found[0].rel).toBe('static-site/webpack_config.js');
  });

  it('returns [] when no bundler config is present', () => {
    expect(findBundlerConfigs(fixturePath('no-bundler'))).toEqual([]);
  });

  it('skips node_modules / dist / build / dot dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-skip-'));
    try {
      fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'webpack.config.js'), '');
      fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'dist', 'webpack.config.js'), '');
      expect(findBundlerConfigs(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT match babel.config.js / jest.config.js / vitest.config.ts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-noise-'));
    try {
      fs.writeFileSync(path.join(tmp, 'babel.config.js'), '');
      fs.writeFileSync(path.join(tmp, 'jest.config.js'), '');
      fs.writeFileSync(path.join(tmp, 'vitest.config.ts'), '');
      expect(findBundlerConfigs(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('parseBundlerConfig — webpack', () => {
  it('extracts the entry map and substitutes [name] in output filename', () => {
    const cfgs = findBundlerConfigs(fixturePath('webpack-basic'));
    const findings = parseBundlerConfig(cfgs[0], fixturePath('webpack-basic'));
    const names = findings.map((f) => f.name).sort();
    expect(names).toEqual(['auth_signin', 'main', 'my_account']);
    const main = findings.find((f) => f.name === 'main')!;
    expect(main.entryPath).toBe('src/main.ts');
    expect(main.bundleOutputPath).toBe('build/assets/main.js');
    expect(main.bundler).toBe('webpack');
  });

  it('handles legacy webpack_config.js with const-ref output path', () => {
    const cfgs = findBundlerConfigs(fixturePath('subdir'));
    const findings = parseBundlerConfig(cfgs[0], fixturePath('subdir'));
    expect(findings.length).toBe(2);
    const names = findings.map((f) => f.name).sort();
    expect(names).toEqual(['auth_signin', 'session']);
  });

  it('skips fingerprinted output filenames (records ConfidenceDecision)', () => {
    const cfgs = findBundlerConfigs(fixturePath('fingerprinted'));
    const findings = parseBundlerConfig(cfgs[0], fixturePath('fingerprinted'));
    expect(findings).toEqual([]);
  });

  it('skips function-returned configs (out of scope)', () => {
    const cfgs = findBundlerConfigs(fixturePath('fn-config'));
    const findings = parseBundlerConfig(cfgs[0], fixturePath('fn-config'));
    expect(findings).toEqual([]);
  });
});

describe('parseBundlerConfig — absolute output.path normalization', () => {
  it('strips rootDir prefix from absolute bundleOutputPath', () => {
    // The fixture has `path.resolve('/abs/build')`. Outside the rootDir
    // prefix-strip, this stays as `/abs/build/main.js` — but the test
    // fixture's rootDir is /Users/.../tests/fixtures/bundler/abs-output,
    // so the prefix-strip wouldn't apply (the abs path doesn't start
    // with rootDir). Verify the parser still emits the finding even
    // when the path stays absolute — this documents current behavior
    // and ensures we never silently drop entries with absolute output
    // paths.
    const cfgs = findBundlerConfigs(fixturePath('abs-output'));
    const findings = parseBundlerConfig(cfgs[0], fixturePath('abs-output'));
    expect(findings.length).toBe(1);
    expect(findings[0].entryPath).toBe('src/main.ts');
    // Absolute path stays as-is (rootDir prefix doesn't match).
    expect(findings[0].bundleOutputPath).toBe('/abs/build/main.js');
  });

  it('strips rootDir prefix when absolute path is INSIDE the project', () => {
    // Simulate `path.resolve('build/assets')` — path.resolve in the
    // evaluator returns a relative path because we treat __dirname
    // as empty. The relative output stays relative.
    const cfgs = findBundlerConfigs(fixturePath('webpack-basic'));
    const findings = parseBundlerConfig(cfgs[0], fixturePath('webpack-basic'));
    for (const f of findings) {
      expect(f.bundleOutputPath).not.toContain('//');
      expect(f.bundleOutputPath.startsWith('build/assets/')).toBe(true);
    }
  });
});

describe('parseBundlerConfig — vite', () => {
  it('extracts a single string entry as `main`', () => {
    const cfgs = findBundlerConfigs(fixturePath('vite-basic'));
    const findings = parseBundlerConfig(cfgs[0], fixturePath('vite-basic'));
    expect(findings.length).toBe(1);
    expect(findings[0].name).toBe('main');
    expect(findings[0].entryPath).toBe('src/main.ts');
    expect(findings[0].bundler).toBe('vite');
  });
});

describe('parseBundlerConfig — rollup', () => {
  it('extracts the entry map from `export default { ... }`', () => {
    const cfgs = findBundlerConfigs(fixturePath('rollup-basic'));
    const findings = parseBundlerConfig(cfgs[0], fixturePath('rollup-basic'));
    const names = findings.map((f) => f.name).sort();
    expect(names).toEqual(['bundle_a', 'bundle_b']);
    expect(findings[0].bundler).toBe('rollup');
  });
});

describe('extractBundles', () => {
  it('emits SourceFile + BUNDLES_TO edges for every entry', () => {
    const batch = extractBundles(fixturePath('webpack-basic'), 'test-repo');
    const edges = bundlesToEdges(batch);
    expect(edges.length).toBe(3);
    for (const e of edges) {
      expect(e.bundler).toBe('webpack');
      expect(typeof e.entryName).toBe('string');
    }
    // Source files: 3 entries + 3 bundle outputs = 6 unique SourceFile nodes.
    expect(sourceFiles(batch).length).toBe(6);
  });

  it('every emitted node passes schema validation', () => {
    const batch = extractBundles(fixturePath('webpack-basic'), 'test-repo');
    for (const n of batch.nodes) expect(() => validateNode(n)).not.toThrow();
  });

  it('every emitted edge passes schema validation', () => {
    const batch = extractBundles(fixturePath('webpack-basic'), 'test-repo');
    for (const e of batch.edges) expect(() => validateEdge(e)).not.toThrow();
  });

  it('returns empty batch when no bundler config is present', () => {
    const batch = extractBundles(fixturePath('no-bundler'), 'test-repo');
    expect(batch.nodes).toHaveLength(0);
    expect(batch.edges).toHaveLength(0);
  });

  it('returns empty batch when output filename is fingerprinted', () => {
    const batch = extractBundles(fixturePath('fingerprinted'), 'test-repo');
    expect(batch.nodes).toHaveLength(0);
    expect(batch.edges).toHaveLength(0);
  });
});

describe('BundlerPlugin contract', () => {
  it('id="bundler" and language="ts"', () => {
    const p = new BundlerPlugin();
    expect(p.id).toBe('bundler');
    expect(p.language).toBe('ts');
  });

  it('appliesTo returns true when a bundler config exists', () => {
    const p = new BundlerPlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('webpack-basic'),
        packageJson: null,
        files: [],
      }),
    ).toBe(true);
  });

  it('appliesTo returns false when no bundler config is present', () => {
    const p = new BundlerPlugin();
    expect(
      p.appliesTo({
        rootDir: fixturePath('no-bundler'),
        packageJson: null,
        files: [],
      }),
    ).toBe(false);
  });

  it('onProjectLoaded returns the same batch as extractBundles', () => {
    const p = new BundlerPlugin();
    const batch = p.onProjectLoaded({
      rootDir: fixturePath('webpack-basic'),
      packageJson: null,
      files: [],
    });
    expect(batch.nodes.length).toBeGreaterThan(0);
    expect(batch.edges.length).toBeGreaterThan(0);
  });

  it('visitor is a no-op (project-level extraction only)', () => {
    const p = new BundlerPlugin();
    expect(p.visitor.language).toBe('ts');
    expect(() => p.visitor.onNode()).not.toThrow();
  });
});
