import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasDependency, type ProjectContext } from '@veoable/plugin-api';
import { ExpressPlugin } from '@veoable/framework-express';
import {
  buildProjectContext,
  detectPlugins,
  discoverManifests,
  discoverSourceFiles,
  discoverWorkspacePackages,
  synthesizeWorkspaceCompilerPaths,
  discoverPythonManifests,
  discoverGoManifests,
  discoverJavaManifests,
  discoverPhpManifests,
  discoverRustManifests,
} from '../discover.js';
import {
  hasPythonPackage,
  hasGoModule,
  hasMavenArtifact,
  hasComposerPackage,
  hasCargoCrate,
} from '@veoable/plugin-api';

/**
 * Tests for monorepo subpackage manifest discovery (#184). The
 * orchestrator must read every `package.json` under the project root,
 * not just the root one — otherwise a monorepo whose root manifest
 * has no framework deps silently gets zero framework plugins
 * activated.
 */

let tmpRoot: string;

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p: string, value: unknown): void {
  mkdir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-discover-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('discoverManifests', () => {
  it('returns the root manifest as the first entry', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    const manifests = discoverManifests(tmpRoot);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.relPath).toBe('.');
    expect(manifests[0]!.packageJson.name).toBe('root');
  });

  it('finds subpackage manifests under the root', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    writeJson(path.join(tmpRoot, 'server', 'package.json'), {
      name: 'server',
      dependencies: { express: '^4.0.0' },
    });
    writeJson(path.join(tmpRoot, 'web', 'package.json'), {
      name: 'web',
      dependencies: { react: '^18.0.0' },
    });
    const manifests = discoverManifests(tmpRoot);
    expect(manifests.map((m) => m.relPath)).toEqual(['.', 'server', 'web']);
  });

  it('walks recursively into nested subpackages', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    writeJson(path.join(tmpRoot, 'apps', 'api', 'package.json'), { name: 'api' });
    writeJson(path.join(tmpRoot, 'apps', 'web', 'package.json'), { name: 'web' });
    writeJson(path.join(tmpRoot, 'packages', 'shared', 'package.json'), { name: 'shared' });
    const manifests = discoverManifests(tmpRoot);
    const rels = manifests.map((m) => m.relPath);
    expect(rels).toContain('apps/api');
    expect(rels).toContain('apps/web');
    expect(rels).toContain('packages/shared');
  });

  it('skips node_modules, build outputs, and dotfiles', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    writeJson(path.join(tmpRoot, 'node_modules', 'express', 'package.json'), {
      name: 'express',
    });
    writeJson(path.join(tmpRoot, 'dist', 'package.json'), { name: 'dist-leak' });
    writeJson(path.join(tmpRoot, '.cache', 'package.json'), { name: 'cache-leak' });
    const manifests = discoverManifests(tmpRoot);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.packageJson.name).toBe('root');
  });

  it('honors user-provided exclude patterns', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    writeJson(path.join(tmpRoot, 'fixtures', 'package.json'), { name: 'fixtures' });
    writeJson(path.join(tmpRoot, 'src', 'package.json'), { name: 'src' });
    const manifests = discoverManifests(tmpRoot, { exclude: ['fixtures'] });
    const rels = manifests.map((m) => m.relPath);
    expect(rels).toEqual(['.', 'src']);
  });

  it('still returns subpackage manifests when there is no root manifest', () => {
    // Tree with no root package.json (e.g. user pointed analyze at a
    // bare directory above their actual workspaces).
    writeJson(path.join(tmpRoot, 'server', 'package.json'), { name: 'server' });
    const manifests = discoverManifests(tmpRoot);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.relPath).toBe('server');
  });
});

describe('buildProjectContext', () => {
  it('synthesizes a merged packageJson whose deps union all subpackage deps', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      devDependencies: { typescript: '^5.0.0' },
    });
    writeJson(path.join(tmpRoot, 'server', 'package.json'), {
      name: 'server',
      dependencies: { express: '^4.0.0' },
    });
    writeJson(path.join(tmpRoot, 'web', 'package.json'), {
      name: 'web',
      dependencies: { react: '^18.0.0' },
    });
    const ctx = buildProjectContext(tmpRoot, []);
    const deps = ctx.packageJson?.dependencies as Record<string, string> | undefined;
    expect(deps).toBeDefined();
    expect(deps!.express).toBe('^4.0.0');
    expect(deps!.react).toBe('^18.0.0');
    // Root devDeps preserved.
    const devDeps = ctx.packageJson?.devDependencies as Record<string, string> | undefined;
    expect(devDeps?.typescript).toBe('^5.0.0');
    // Top-level fields come from root.
    expect(ctx.packageJson?.name).toBe('root');
  });

  it('exposes the per-subpackage manifests array', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    writeJson(path.join(tmpRoot, 'server', 'package.json'), {
      name: 'server',
      dependencies: { express: '^4.0.0' },
    });
    const ctx = buildProjectContext(tmpRoot, []);
    expect(ctx.manifests).toBeDefined();
    expect(ctx.manifests!).toHaveLength(2);
    const serverManifest = ctx.manifests!.find((m) => m.relPath === 'server');
    expect(serverManifest?.packageJson.name).toBe('server');
  });

  it('returns null packageJson when no manifests exist anywhere', () => {
    const ctx = buildProjectContext(tmpRoot, []);
    expect(ctx.packageJson).toBeNull();
    expect(ctx.manifests ?? []).toHaveLength(0);
  });

  it('does not let subpackage dep versions override root-declared versions', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      dependencies: { typescript: '^5.5.0' },
    });
    writeJson(path.join(tmpRoot, 'sub', 'package.json'), {
      name: 'sub',
      dependencies: { typescript: '^4.0.0' },
    });
    const ctx = buildProjectContext(tmpRoot, []);
    const deps = ctx.packageJson?.dependencies as Record<string, string>;
    expect(deps.typescript).toBe('^5.5.0');
  });
});

describe('detectPlugins on a monorepo', () => {
  it('activates a framework whose dep lives only in a subpackage manifest (#184)', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      // No framework deps in the root — only build tooling.
      devDependencies: { 'dependency-cruiser': '^17.0.0' },
    });
    writeJson(path.join(tmpRoot, 'server', 'package.json'), {
      name: 'server',
      dependencies: { express: '^4.18.0' },
    });
    const ctx = buildProjectContext(tmpRoot, []);
    const plugins = detectPlugins(ctx);
    const ids = plugins.map((p) => p.id);
    expect(ids).toContain('express');
  });

  it('would NOT have activated express on this fixture if the orchestrator only read the root manifest (regression pin for #184)', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      devDependencies: { 'dependency-cruiser': '^17.0.0' },
    });
    writeJson(path.join(tmpRoot, 'server', 'package.json'), {
      name: 'server',
      dependencies: { express: '^4.18.0' },
    });
    // Simulate the OLD behavior: a context where packageJson is the
    // root manifest only and `manifests` is undefined.
    const rootOnly: ProjectContext = {
      rootDir: tmpRoot,
      packageJson: JSON.parse(
        fs.readFileSync(path.join(tmpRoot, 'package.json'), 'utf8'),
      ),
      files: [],
    };
    expect(new ExpressPlugin().appliesTo(rootOnly)).toBe(false);
  });
});

describe('hasDependency helper', () => {
  it('finds a dep declared in any manifest', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    writeJson(path.join(tmpRoot, 'server', 'package.json'), {
      name: 'server',
      dependencies: { express: '^4.18.0' },
    });
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasDependency(ctx, 'express')).toBe(true);
    expect(hasDependency(ctx, 'fastify')).toBe(false);
  });

  it('finds deps in devDependencies and peerDependencies', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      devDependencies: { typescript: '^5.0.0' },
      peerDependencies: { react: '>=18' },
    });
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasDependency(ctx, 'typescript')).toBe(true);
    expect(hasDependency(ctx, 'react')).toBe(true);
  });

  it('handles a context with neither packageJson nor manifests gracefully', () => {
    const ctx: ProjectContext = { rootDir: '/x', packageJson: null, files: [] };
    expect(hasDependency(ctx, 'express')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Workspace detection (#195)
// ──────────────────────────────────────────────────────────────────────

describe('discoverWorkspacePackages', () => {
  it('returns empty array when no workspace declaration exists', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    writeJson(path.join(tmpRoot, 'server', 'package.json'), { name: 'server' });
    writeJson(path.join(tmpRoot, 'web', 'package.json'), { name: 'web' });
    const manifests = discoverManifests(tmpRoot);
    expect(discoverWorkspacePackages(tmpRoot, manifests)).toEqual([]);
  });

  it('honors npm/yarn classic `workspaces: [...]` array form', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      workspaces: ['apps/*', 'packages/*'],
    });
    writeJson(path.join(tmpRoot, 'apps', 'api', 'package.json'), { name: '@scope/api' });
    writeJson(path.join(tmpRoot, 'apps', 'web', 'package.json'), { name: '@scope/web' });
    writeJson(path.join(tmpRoot, 'packages', 'shared', 'package.json'), { name: '@scope/shared' });
    writeJson(path.join(tmpRoot, 'docs', 'tools', 'package.json'), { name: 'docs-tools' });
    const manifests = discoverManifests(tmpRoot);
    const pkgs = discoverWorkspacePackages(tmpRoot, manifests);
    expect(pkgs.map((p) => p.name).sort()).toEqual(['@scope/api', '@scope/shared', '@scope/web']);
    expect(pkgs.find((p) => p.name === 'docs-tools')).toBeUndefined();
  });

  it('honors yarn workspaces object form `workspaces: { packages: [...] }`', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      workspaces: { packages: ['apps/*'], nohoist: ['some-pkg'] },
    });
    writeJson(path.join(tmpRoot, 'apps', 'api', 'package.json'), { name: '@scope/api' });
    const manifests = discoverManifests(tmpRoot);
    const pkgs = discoverWorkspacePackages(tmpRoot, manifests);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]!.name).toBe('@scope/api');
  });

  it('honors pnpm-workspace.yaml `packages:` block-list', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    fs.writeFileSync(
      path.join(tmpRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\n  - "packages/*"\n\nonlyBuiltDependencies:\n  - "esbuild"\n',
    );
    writeJson(path.join(tmpRoot, 'apps', 'api', 'package.json'), { name: '@v/api' });
    writeJson(path.join(tmpRoot, 'packages', 'shared', 'package.json'), { name: '@v/shared' });
    const manifests = discoverManifests(tmpRoot);
    const pkgs = discoverWorkspacePackages(tmpRoot, manifests);
    expect(pkgs.map((p) => p.name).sort()).toEqual(['@v/api', '@v/shared']);
  });

  it('handles unquoted entries in pnpm-workspace.yaml', () => {
    writeJson(path.join(tmpRoot, 'package.json'), { name: 'root' });
    fs.writeFileSync(
      path.join(tmpRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - apps/*\n  - packages/*\n',
    );
    writeJson(path.join(tmpRoot, 'apps', 'a', 'package.json'), { name: 'a' });
    writeJson(path.join(tmpRoot, 'packages', 'p', 'package.json'), { name: 'p' });
    const manifests = discoverManifests(tmpRoot);
    expect(discoverWorkspacePackages(tmpRoot, manifests).map((p) => p.name).sort()).toEqual(['a', 'p']);
  });

  it('skips manifests without a name field', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      workspaces: ['apps/*'],
    });
    writeJson(path.join(tmpRoot, 'apps', 'unnamed', 'package.json'), { version: '1.0.0' });
    writeJson(path.join(tmpRoot, 'apps', 'named', 'package.json'), { name: '@scope/named' });
    const manifests = discoverManifests(tmpRoot);
    const pkgs = discoverWorkspacePackages(tmpRoot, manifests);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]!.name).toBe('@scope/named');
  });

  it('combines npm `workspaces` and pnpm-workspace.yaml when both exist', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      workspaces: ['apps/*'],
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "extras/*"\n',
    );
    writeJson(path.join(tmpRoot, 'apps', 'a', 'package.json'), { name: '@s/a' });
    writeJson(path.join(tmpRoot, 'extras', 'b', 'package.json'), { name: '@s/b' });
    const manifests = discoverManifests(tmpRoot);
    const pkgs = discoverWorkspacePackages(tmpRoot, manifests);
    expect(pkgs.map((p) => p.name).sort()).toEqual(['@s/a', '@s/b']);
  });

  it('does not match the root manifest as a workspace member', () => {
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'root',
      workspaces: ['*'], // pathological but legal
    });
    writeJson(path.join(tmpRoot, 'sub', 'package.json'), { name: 'sub' });
    const manifests = discoverManifests(tmpRoot);
    const pkgs = discoverWorkspacePackages(tmpRoot, manifests);
    expect(pkgs.map((p) => p.name)).toEqual(['sub']);
  });
});

describe('synthesizeWorkspaceCompilerPaths', () => {
  it('emits both bare and slash-suffix entries for each package', () => {
    const paths = synthesizeWorkspaceCompilerPaths('/proj', [
      { name: '@scope/api', relPath: 'apps/api' },
      { name: '@scope/shared', relPath: 'packages/shared' },
    ]);
    expect(paths['@scope/api']).toEqual(['/proj/apps/api']);
    expect(paths['@scope/api/*']).toEqual(['/proj/apps/api/*']);
    expect(paths['@scope/shared']).toEqual(['/proj/packages/shared']);
    expect(paths['@scope/shared/*']).toEqual(['/proj/packages/shared/*']);
  });

  it('returns an empty map for an empty package list', () => {
    expect(synthesizeWorkspaceCompilerPaths('/proj', [])).toEqual({});
  });

  // #371 — prefer source-tree entry over the package directory.
  // Without this, ts-morph follows the package's own `main`
  // resolution and lands on the built JS output, losing type
  // info and breaking receiver resolution for any pattern that
  // requires walking the source tree.
  describe('#371 — source-entry preference', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-synth-src-'));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('prefers src/index.ts when present', () => {
      const pkgDir = path.join(tmp, 'packages/shared');
      fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'src/index.ts'), 'export {};');
      const paths = synthesizeWorkspaceCompilerPaths(tmp, [
        { name: '@scope/shared', relPath: 'packages/shared' },
      ]);
      // Source entry FIRST, package dir as fallback.
      expect(paths['@scope/shared'][0]).toBe(path.join(pkgDir, 'src/index.ts'));
      expect(paths['@scope/shared'][1]).toBe(pkgDir);
      // Slash-suffix maps to src/ dir then package dir.
      expect(paths['@scope/shared/*'][0]).toBe(`${path.join(pkgDir, 'src')}/*`);
      expect(paths['@scope/shared/*'][1]).toBe(`${pkgDir}/*`);
    });

    it('prefers package.json exports["."] string when set to a .ts file', () => {
      // Mirrors rallly's @rallly/database: `"exports": { ".": "./src/client.ts" }`
      const pkgDir = path.join(tmp, 'packages/database');
      fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'src/client.ts'), 'export {};');
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@rallly/database', exports: { '.': './src/client.ts' } }),
      );
      const paths = synthesizeWorkspaceCompilerPaths(tmp, [
        { name: '@rallly/database', relPath: 'packages/database' },
      ]);
      expect(paths['@rallly/database'][0]).toBe(path.join(pkgDir, 'src/client.ts'));
    });

    it('prefers package.json exports["."]["import"] (conditional record) when set to .ts', () => {
      const pkgDir = path.join(tmp, 'packages/db');
      fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'src/index.ts'), 'export {};');
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@scope/db',
          exports: { '.': { import: './src/index.ts', require: './dist/index.cjs' } },
        }),
      );
      const paths = synthesizeWorkspaceCompilerPaths(tmp, [
        { name: '@scope/db', relPath: 'packages/db' },
      ]);
      expect(paths['@scope/db'][0]).toBe(path.join(pkgDir, 'src/index.ts'));
    });

    it('falls back to package dir when only built JS is declared', () => {
      // formbricks shape: main → dist/index.cjs, exports → dist/...
      // Neither is a .ts source, so the synthesizer should fall back
      // to the package directory rather than mapping onto a built
      // JS file (which would prevent receiver chain resolution).
      const pkgDir = path.join(tmp, 'packages/database');
      fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'dist/index.js'), 'module.exports = {};');
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@formbricks/database',
          main: './dist/index.cjs',
          exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } },
        }),
      );
      // No src/, no index.ts at package root either.
      const paths = synthesizeWorkspaceCompilerPaths(tmp, [
        { name: '@formbricks/database', relPath: 'packages/database' },
      ]);
      expect(paths['@formbricks/database']).toEqual([pkgDir]);
      expect(paths['@formbricks/database/*']).toEqual([`${pkgDir}/*`]);
    });

    it('falls back when src/index.ts AND declared exports are both absent', () => {
      const pkgDir = path.join(tmp, 'packages/utils');
      fs.mkdirSync(pkgDir, { recursive: true });
      // No package.json, no src/, no index.ts.
      const paths = synthesizeWorkspaceCompilerPaths(tmp, [
        { name: '@scope/utils', relPath: 'packages/utils' },
      ]);
      expect(paths['@scope/utils']).toEqual([pkgDir]);
    });

    it('survives a malformed package.json without throwing', () => {
      const pkgDir = path.join(tmp, 'packages/borked');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), '{ not json');
      // Should fall through cleanly to the package directory.
      expect(() =>
        synthesizeWorkspaceCompilerPaths(tmp, [
          { name: '@scope/borked', relPath: 'packages/borked' },
        ]),
      ).not.toThrow();
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Per-ecosystem manifest discovery (#203)
// ──────────────────────────────────────────────────────────────────────

function writeFile(p: string, contents: string): void {
  mkdir(path.dirname(p));
  fs.writeFileSync(p, contents);
}

describe('discoverPythonManifests', () => {
  it('parses requirements.txt with version specifiers', () => {
    writeFile(path.join(tmpRoot, 'requirements.txt'), 'fastapi==0.100.0\npydantic>=2.0\n# comment\nrequests\n');
    const manifests = discoverPythonManifests(tmpRoot);
    expect(manifests).toHaveLength(1);
    const deps = manifests[0]!.dependencies;
    expect(deps.fastapi).toBe('==0.100.0');
    expect(deps.pydantic).toBe('>=2.0');
    expect(deps.requests).toBe('*');
  });

  it('skips -r / -e / git+ / http(s) lines in requirements.txt', () => {
    writeFile(path.join(tmpRoot, 'requirements.txt'), '-r dev.txt\n-e .\ngit+https://github.com/foo/bar.git\nhttps://x/y.tar.gz\nflask==3.0\n');
    const manifests = discoverPythonManifests(tmpRoot);
    expect(Object.keys(manifests[0]!.dependencies)).toEqual(['flask']);
  });

  it('parses pyproject.toml [tool.poetry.dependencies]', () => {
    writeFile(path.join(tmpRoot, 'pyproject.toml'), `
[tool.poetry]
name = "app"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.100"
sqlalchemy = { version = "^2.0", extras = ["asyncio"] }
`);
    const manifests = discoverPythonManifests(tmpRoot);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.dependencies.fastapi).toBe('^0.100');
    expect(manifests[0]!.dependencies.sqlalchemy).toBe('^2.0');
    expect(manifests[0]!.dependencies.python).toBeUndefined();
  });

  it('parses pyproject.toml PEP 621 [project] dependencies array', () => {
    writeFile(path.join(tmpRoot, 'pyproject.toml'), `
[project]
name = "app"
dependencies = [
  "fastapi>=0.100",
  "pydantic",
  "sqlalchemy~=2.0",
]
`);
    const manifests = discoverPythonManifests(tmpRoot);
    expect(manifests[0]!.dependencies.fastapi).toBe('>=0.100');
    expect(manifests[0]!.dependencies.pydantic).toBe('*');
    expect(manifests[0]!.dependencies.sqlalchemy).toBe('~=2.0');
  });

  it('parses Pipfile [packages] sections', () => {
    writeFile(path.join(tmpRoot, 'Pipfile'), `
[[source]]
url = "https://pypi.org/simple"

[packages]
django = "==4.2"
psycopg2 = "*"

[dev-packages]
pytest = "*"
`);
    const manifests = discoverPythonManifests(tmpRoot);
    expect(manifests[0]!.dependencies.django).toBe('==4.2');
    expect(manifests[0]!.dependencies.pytest).toBe('*');
  });

  it('walks subpackages — finds requirements.txt in apps/api/', () => {
    writeFile(path.join(tmpRoot, 'apps', 'api', 'requirements.txt'), 'fastapi==0.100\n');
    writeFile(path.join(tmpRoot, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web' }));
    const manifests = discoverPythonManifests(tmpRoot);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.relPath).toBe('apps/api');
  });
});

describe('discoverGoManifests', () => {
  it('parses go.mod require ( ... ) block', () => {
    writeFile(path.join(tmpRoot, 'go.mod'), `
module example.com/app

go 1.21

require (
  github.com/gin-gonic/gin v1.9.0
  gorm.io/gorm v1.25.0 // indirect
)
`);
    const manifests = discoverGoManifests(tmpRoot);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.dependencies['github.com/gin-gonic/gin']).toBe('v1.9.0');
    expect(manifests[0]!.dependencies['gorm.io/gorm']).toBe('v1.25.0');
  });

  it('parses single-line `require X version` form', () => {
    writeFile(path.join(tmpRoot, 'go.mod'), 'module x\nrequire github.com/gin-gonic/gin v1.9.0\n');
    const manifests = discoverGoManifests(tmpRoot);
    expect(manifests[0]!.dependencies['github.com/gin-gonic/gin']).toBe('v1.9.0');
  });
});

describe('discoverJavaManifests', () => {
  it('parses pom.xml dependencies', () => {
    writeFile(path.join(tmpRoot, 'pom.xml'), `
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.0.0</version>
    </dependency>
    <dependency>
      <groupId>org.hibernate</groupId>
      <artifactId>hibernate-core</artifactId>
    </dependency>
  </dependencies>
</project>
`);
    const manifests = discoverJavaManifests(tmpRoot);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.dependencies['org.springframework.boot:spring-boot-starter-web']).toBe('3.0.0');
    expect(manifests[0]!.dependencies['org.hibernate:hibernate-core']).toBe('*');
  });

  it('parses build.gradle implementation/api/testImplementation entries', () => {
    writeFile(path.join(tmpRoot, 'build.gradle'), `
dependencies {
  implementation 'org.springframework.boot:spring-boot-starter-web:3.0.0'
  api 'com.google.guava:guava:32.0'
  testImplementation 'junit:junit:4.13.2'
}
`);
    const manifests = discoverJavaManifests(tmpRoot);
    expect(manifests[0]!.dependencies['org.springframework.boot:spring-boot-starter-web']).toBe('3.0.0');
    expect(manifests[0]!.dependencies['com.google.guava:guava']).toBe('32.0');
    expect(manifests[0]!.dependencies['junit:junit']).toBe('4.13.2');
  });

  it('parses build.gradle.kts (Kotlin DSL)', () => {
    writeFile(path.join(tmpRoot, 'build.gradle.kts'), `
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-data-jpa:3.0.0")
}
`);
    const manifests = discoverJavaManifests(tmpRoot);
    expect(manifests[0]!.dependencies['org.springframework.boot:spring-boot-starter-data-jpa']).toBe('3.0.0');
  });
});

describe('discoverPhpManifests', () => {
  it('parses composer.json require + require-dev', () => {
    writeFile(path.join(tmpRoot, 'composer.json'), JSON.stringify({
      name: 'my/app',
      require: { 'laravel/framework': '^10.0', 'guzzlehttp/guzzle': '^7.0' },
      'require-dev': { 'phpunit/phpunit': '^10' },
    }));
    const manifests = discoverPhpManifests(tmpRoot);
    expect(manifests[0]!.dependencies['laravel/framework']).toBe('^10.0');
    expect(manifests[0]!.dependencies['guzzlehttp/guzzle']).toBe('^7.0');
    expect(manifests[0]!.dependencies['phpunit/phpunit']).toBe('^10');
  });

  it('returns null parser result for invalid JSON (record skipped)', () => {
    writeFile(path.join(tmpRoot, 'composer.json'), '{ this is not json');
    expect(discoverPhpManifests(tmpRoot)).toEqual([]);
  });
});

describe('discoverRustManifests', () => {
  it('parses Cargo.toml [dependencies] and [dev-dependencies]', () => {
    writeFile(path.join(tmpRoot, 'Cargo.toml'), `
[package]
name = "app"

[dependencies]
axum = "0.7"
tokio = { version = "1.0", features = ["full"] }

[dev-dependencies]
mockito = "1.0"
`);
    const manifests = discoverRustManifests(tmpRoot);
    expect(manifests[0]!.dependencies.axum).toBe('0.7');
    expect(manifests[0]!.dependencies.tokio).toBe('1.0');
    expect(manifests[0]!.dependencies.mockito).toBe('1.0');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Per-ecosystem hasX helpers (#203)
// ──────────────────────────────────────────────────────────────────────

describe('hasPythonPackage helper', () => {
  it('matches a dep declared in any subpackage manifest', () => {
    writeFile(path.join(tmpRoot, 'apps', 'api', 'requirements.txt'), 'fastapi==0.100\n');
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasPythonPackage(ctx, 'fastapi')).toBe(true);
    expect(hasPythonPackage(ctx, 'django')).toBe(false);
  });

  it('normalizes name per PEP 503 (case-insensitive, _/. → -)', () => {
    writeFile(path.join(tmpRoot, 'requirements.txt'), 'Django-REST-Framework==3.14\n');
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasPythonPackage(ctx, 'django-rest-framework')).toBe(true);
    expect(hasPythonPackage(ctx, 'djangorestframework')).toBe(false);
    expect(hasPythonPackage(ctx, 'DJANGO_REST_FRAMEWORK')).toBe(true);
  });
});

describe('hasGoModule helper', () => {
  it('matches a module declared in any go.mod', () => {
    writeFile(path.join(tmpRoot, 'services', 'auth', 'go.mod'), `
module example.com/auth
require github.com/gin-gonic/gin v1.9.0
`);
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasGoModule(ctx, 'github.com/gin-gonic/gin')).toBe(true);
    expect(hasGoModule(ctx, 'github.com/labstack/echo')).toBe(false);
  });
});

describe('hasMavenArtifact helper', () => {
  it('matches by exact group:artifact coordinate', () => {
    writeFile(path.join(tmpRoot, 'pom.xml'), `
<project><dependencies>
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.0</version></dependency>
</dependencies></project>
`);
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasMavenArtifact(ctx, 'org.springframework.boot:spring-boot-starter-web')).toBe(true);
    expect(hasMavenArtifact(ctx, 'unrelated:thing')).toBe(false);
  });

  it('matches by regex (e.g. anything matching /spring-boot/)', () => {
    writeFile(path.join(tmpRoot, 'build.gradle'), `
dependencies { implementation 'org.springframework.boot:spring-boot-starter-data-jpa:3.0' }
`);
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasMavenArtifact(ctx, /spring-boot/)).toBe(true);
  });
});

describe('hasComposerPackage helper', () => {
  it('matches a dep declared in composer.json', () => {
    writeFile(path.join(tmpRoot, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^10.0' },
    }));
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasComposerPackage(ctx, 'laravel/framework')).toBe(true);
    expect(hasComposerPackage(ctx, 'symfony/console')).toBe(false);
  });
});

describe('hasCargoCrate helper', () => {
  it('matches a crate declared in Cargo.toml', () => {
    writeFile(path.join(tmpRoot, 'Cargo.toml'), '[dependencies]\naxum = "0.7"\n');
    const ctx = buildProjectContext(tmpRoot, []);
    expect(hasCargoCrate(ctx, 'axum')).toBe(true);
    expect(hasCargoCrate(ctx, 'actix-web')).toBe(false);
  });
});


describe('discoverSourceFiles vendored-bundle exclusion (#530)', () => {
  function writeFile(rel: string, content: string): void {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  it('skips bower_components', () => {
    writeFile('src/index.ts', 'export const x = 1;\n');
    writeFile('bower_components/jquery/jquery.js', 'window.jQuery = function(){};\n');
    const files = discoverSourceFiles(tmpRoot);
    expect(files).toContain('src/index.ts');
    expect(files.some((f) => f.startsWith('bower_components'))).toBe(false);
  });

  it('skips *.min.js, *-vendor.js, and *.umd.js by filename', () => {
    writeFile('src/index.ts', 'export const x = 1;\n');
    writeFile('public/app.min.js', 'a=1;\n');
    writeFile('public/runtime-vendor.js', 'c=1;\n');
    writeFile('public/lib.umd.js', 'd=1;\n');
    writeFile('public/legit.js', 'export default 1;\n');
    const files = discoverSourceFiles(tmpRoot);
    expect(files).toContain('src/index.ts');
    expect(files).toContain('public/legit.js');
    expect(files).not.toContain('public/app.min.js');
    expect(files).not.toContain('public/runtime-vendor.js');
    expect(files).not.toContain('public/lib.umd.js');
  });

  it('keeps small *.bundle.js and *.pack.js (treats them as legitimate source)', () => {
    // webpack.bundle.js, browserify pack files, etc. are normal source
    // file names. Only real (large/minified) vendored bundles with those
    // names should trip the content sniff.
    writeFile('src/webpack.bundle.js', 'module.exports = {};\n');
    writeFile('src/browserify.pack.js', 'module.exports = {};\n');
    const files = discoverSourceFiles(tmpRoot);
    expect(files).toContain('src/webpack.bundle.js');
    expect(files).toContain('src/browserify.pack.js');
  });

  it('skips well-known vendor runtime names ONLY when they exceed 50KB', () => {
    // Real vendored jQuery/Moment/Vue runtimes are hundreds of KB. Fake
    // them with 60KB of plain bytes so the size floor trips.
    const bigBlob = 'a'.repeat(60_000);
    writeFile('assets/jquery.js', bigBlob);
    writeFile('assets/moment.js', bigBlob);
    writeFile('assets/vue.global.js', bigBlob);
    // A user's own small `react.development.js` (tutorial / demo /
    // component file) stays in — under the size floor.
    writeFile('assets/react.development.js', 'export default 1;\n');
    writeFile('assets/myapp.js', 'export default 1;\n');
    const files = discoverSourceFiles(tmpRoot);
    expect(files).toContain('assets/myapp.js');
    expect(files).toContain('assets/react.development.js');
    expect(files).not.toContain('assets/jquery.js');
    expect(files).not.toContain('assets/moment.js');
    expect(files).not.toContain('assets/vue.global.js');
  });

  it('skips large JS files whose first 4KB averages >200 chars/line (minified heuristic)', () => {
    // 150KB single-line — definitely minified.
    const oneLine = 'var x' + '=1'.repeat(80_000) + ';';
    writeFile('public/scripts/unnamed-bundle.js', oneLine);
    // 150KB but normal source — newlines every ~40 chars.
    const wellFormed = Array.from({ length: 4000 }, (_, i) => `const x${i} = ${i};`).join('\n');
    writeFile('public/scripts/big-source.js', wellFormed);
    const files = discoverSourceFiles(tmpRoot);
    expect(files).toContain('public/scripts/big-source.js');
    expect(files).not.toContain('public/scripts/unnamed-bundle.js');
  });

  it('keeps small JS files even when filename-pattern-free (no false positives)', () => {
    writeFile('src/utils.js', 'export const x = 1;\n');
    writeFile('src/handler.mjs', 'export default {};\n');
    const files = discoverSourceFiles(tmpRoot);
    expect(files).toContain('src/utils.js');
    expect(files).toContain('src/handler.mjs');
  });

  it('does not sniff TypeScript files (no perf cost on TS-heavy monorepos)', () => {
    // Even a 200KB single-line TS file is kept — TS sources are virtually
    // never minified, and statting every TS file in a monorepo is the
    // cost we explicitly avoid.
    const giantLine = 'export const x' + '=1'.repeat(100_000) + ';';
    writeFile('src/generated.ts', giantLine);
    const files = discoverSourceFiles(tmpRoot);
    expect(files).toContain('src/generated.ts');
  });
});
