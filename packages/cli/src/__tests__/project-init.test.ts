import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../project.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veoable-init-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFile(relPath: string, contents: string): void {
  const abs = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function makePackage(relDir: string, pkgName: string): void {
  writeFile(`${relDir}/package.json`, JSON.stringify({ name: pkgName, version: '0.0.0' }));
}

describe('initProject (#292 — workspace glob expansion)', () => {
  it('expands `packages/*` to immediate-child packages', () => {
    writeFile('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    makePackage('packages/api', '@app/api');
    makePackage('packages/web', '@app/web');
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.map((r) => r.name).sort()).toEqual(['api', 'web']);
  });

  it('expands `packages/**` to recursively-found packages (hoppscotch shape)', () => {
    // The bug case — pnpm allows `packages/**` and the original
    // expander silently dropped it.
    writeFile('pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
    makePackage('packages/hoppscotch-backend', '@hop/backend');
    makePackage('packages/hoppscotch-common', '@hop/common');
    makePackage('packages/hoppscotch-cli', '@hop/cli');
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.length).toBe(3);
    expect(cfg.repos.map((r) => r.name).sort()).toEqual([
      'hoppscotch-backend', 'hoppscotch-cli', 'hoppscotch-common',
    ]);
  });

  it('`packages/**` recurses into nested directories', () => {
    writeFile('pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
    makePackage('packages/group-a/pkg1', '@app/pkg1');
    makePackage('packages/group-b/pkg2', '@app/pkg2');
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.length).toBe(2);
    expect(cfg.repos.map((r) => r.name).sort()).toEqual(['pkg1', 'pkg2']);
  });

  it('does NOT descend into a directory that is itself a package', () => {
    // If `packages/foo/` has a package.json, don't also enumerate
    // `packages/foo/sub/` even if THAT also has a package.json.
    writeFile('pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
    makePackage('packages/foo', '@app/foo');
    makePackage('packages/foo/sub', '@app/foo-sub'); // shouldn't be picked up
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.length).toBe(1);
    expect(cfg.repos[0].name).toBe('foo');
  });

  it('dedups overlapping globs (`packages/*` + `packages/**`)', () => {
    writeFile('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'packages/**'\n");
    makePackage('packages/api', '@app/api');
    makePackage('packages/web', '@app/web');
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.length).toBe(2);
  });

  it('explicit path globs still work (`apps/api`)', () => {
    writeFile('pnpm-workspace.yaml', "packages:\n  - 'apps/api'\n  - 'apps/web'\n");
    makePackage('apps/api', '@app/api');
    makePackage('apps/web', '@app/web');
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.length).toBe(2);
  });

  it('package.json `workspaces` array works the same way', () => {
    writeFile('package.json', JSON.stringify({
      name: 'root',
      workspaces: ['packages/**'],
    }));
    makePackage('packages/a', '@app/a');
    makePackage('packages/b', '@app/b');
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.length).toBe(2);
  });

  it('skips node_modules and .dirs even inside `**`', () => {
    writeFile('pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
    makePackage('packages/api', '@app/api');
    makePackage('packages/node_modules/some-pkg', 'should-be-skipped');
    makePackage('packages/.cache/internal', 'also-skipped');
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.map((r) => r.name)).toEqual(['api']);
  });

  it('unquoted yaml entries also work', () => {
    writeFile('pnpm-workspace.yaml', "packages:\n  - packages/api\n  - packages/web\n");
    makePackage('packages/api', '@app/api');
    makePackage('packages/web', '@app/web');
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.length).toBe(2);
  });

  it('skips pnpm negation globs (!packages/excluded/*)', () => {
    writeFile('pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n  - '!packages/legacy/**'\n");
    makePackage('packages/api', '@app/api');
    makePackage('packages/web', '@app/web');
    const cfg = initProject(tmpRoot);
    // Negation glob is dropped — user keeps any matches from the
    // positive globs above.
    expect(cfg.repos.length).toBe(2);
    expect(cfg.repos.map((r) => r.name).sort()).toEqual(['api', 'web']);
  });

  it('falls back to single-repo config when no workspace declared', () => {
    writeFile('package.json', JSON.stringify({ name: 'lonely-repo' }));
    const cfg = initProject(tmpRoot);
    expect(cfg.repos.length).toBe(1);
    expect(cfg.repos[0].path).toBe('.');
  });
});
