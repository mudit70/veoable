import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWorkspaceRoot } from '../project.js';

/**
 * #345 — Walk up from the project config's directory looking for the
 * outer workspace declaration. The five markers below all indicate
 * the same thing in different ecosystems: "this directory is the
 * monorepo root". `findWorkspaceRoot` should return the directory
 * containing the first marker encountered while walking up, falling
 * back to the input directory when none is found.
 */
describe('findWorkspaceRoot (#345)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-fwr-'));
    // Resolve symlinks so comparisons match what findWorkspaceRoot
    // returns (macOS' /var → /private/var, /tmp → /private/tmp).
    tmp = await fs.realpath(tmp);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  for (const marker of ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json'] as const) {
    it(`detects ${marker} one level up from configDir`, async () => {
      await fs.writeFile(path.join(tmp, marker), '');
      await fs.mkdir(path.join(tmp, 'configs'), { recursive: true });
      const root = findWorkspaceRoot(path.join(tmp, 'configs'));
      expect(root).toBe(tmp);
    });
  }

  it('detects a `package.json` with a `workspaces` field (npm/yarn classic)', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    );
    await fs.mkdir(path.join(tmp, 'configs'), { recursive: true });
    const root = findWorkspaceRoot(path.join(tmp, 'configs'));
    expect(root).toBe(tmp);
  });

  it('detects a `package.json` with a `workspaces` object (yarn berry / nohoist)', async () => {
    // Yarn berry and yarn-classic-with-nohoist use the OBJECT shape:
    // `workspaces: { packages: [...], nohoist: [...] }`. The marker check
    // is presence-of-field, not shape, so this must also activate.
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'root',
        private: true,
        workspaces: { packages: ['packages/*'], nohoist: ['**/react-native'] },
      }),
    );
    await fs.mkdir(path.join(tmp, 'configs'), { recursive: true });
    const root = findWorkspaceRoot(path.join(tmp, 'configs'));
    expect(root).toBe(tmp);
  });

  it('ignores a `package.json` WITHOUT a `workspaces` field', async () => {
    // The walk-up should skip this `package.json` (it's a regular
    // single-package manifest, not a workspace declaration) and keep
    // walking. With no markers found anywhere, falls back to input.
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'single', version: '0.0.1' }),
    );
    const configsDir = path.join(tmp, 'configs');
    await fs.mkdir(configsDir, { recursive: true });
    const root = findWorkspaceRoot(configsDir);
    // Fallback to configDir means no marker was found above.
    expect(root).toBe(configsDir);
  });

  it('returns the FIRST marker dir found when walking up multiple levels', async () => {
    // /tmp/.../workspace ← marker here
    //          └── apps
    //              └── web
    //                  └── configs ← configDir
    await fs.writeFile(path.join(tmp, 'pnpm-workspace.yaml'), '');
    const configDir = path.join(tmp, 'apps', 'web', 'configs');
    await fs.mkdir(configDir, { recursive: true });
    const root = findWorkspaceRoot(configDir);
    expect(root).toBe(tmp);
  });

  it('falls back to configDir when no marker is found anywhere up the tree', async () => {
    // No markers anywhere in `tmp` — the walk reaches filesystem root
    // and exits. (System-level filesystem roots may have stray
    // package.json with workspaces, but that's outside the tmp tree.)
    await fs.mkdir(path.join(tmp, 'configs'), { recursive: true });
    const configDir = path.join(tmp, 'configs');
    const root = findWorkspaceRoot(configDir);
    // We can't assert root === configDir absolutely (a parent of tmp
    // might have a marker), but for our isolated tmp tree we can
    // assert it isn't inside tmp beyond configDir itself.
    expect(root === configDir || !root.startsWith(tmp)).toBe(true);
  });

  it('returns configDir itself when it contains a marker (zero-step walk)', async () => {
    await fs.writeFile(path.join(tmp, 'nx.json'), '');
    const root = findWorkspaceRoot(tmp);
    expect(root).toBe(tmp);
  });

  it('survives a malformed `package.json` without throwing', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{ not json');
    await fs.mkdir(path.join(tmp, 'configs'), { recursive: true });
    // Should not throw, should treat malformed manifest as
    // "not-a-marker" and keep walking.
    expect(() => findWorkspaceRoot(path.join(tmp, 'configs'))).not.toThrow();
  });

  // The walk-up is bounded by (1) a `.git` directory at the current
  // level, (2) `$HOME`, (3) the filesystem root. These bounds prevent
  // the scan from leaking out of the repository or into user-level
  // config files (a stray `~/package.json` with a `workspaces`
  // field used to be picked as the workspace root on dev machines).
  it('stops at a .git boundary even if a marker exists higher up', async () => {
    // /tmp/.../outer        ← marker here (must NOT be reached)
    //          └── repo
    //              ├── .git
    //              └── configs   ← configDir
    await fs.writeFile(path.join(tmp, 'pnpm-workspace.yaml'), '');
    const repo = path.join(tmp, 'repo');
    const configsDir = path.join(repo, 'configs');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(configsDir, { recursive: true });
    const root = findWorkspaceRoot(configsDir);
    // Bounded at the .git root — should not pick up the outer marker.
    expect(root).toBe(repo);
  });

  it('treats the .git boundary itself as a valid marker location', async () => {
    // A repo whose root IS the workspace (single-repo case): the
    // .git sentinel must not prevent matching markers AT the .git
    // directory itself.
    await fs.mkdir(path.join(tmp, '.git'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'pnpm-workspace.yaml'), '');
    await fs.mkdir(path.join(tmp, 'configs'), { recursive: true });
    const root = findWorkspaceRoot(path.join(tmp, 'configs'));
    expect(root).toBe(tmp);
  });

  it('stops at $HOME, refusing to read user-level config files', async () => {
    // Simulate a configDir nested under $HOME with NO markers in the
    // path between configDir and $HOME. The walk must NOT reach
    // $HOME's parent (where stray markers might exist on real dev
    // machines).
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-fake-home-'));
    try {
      // Plant a marker JUST ABOVE $HOME — if the walk crossed the
      // boundary, it would pick this up.
      const fakeHomeReal = await fs.realpath(fakeHome);
      const aboveHome = path.dirname(fakeHomeReal);
      // We can't safely write into the parent of an OS tmp dir;
      // instead, verify the boundary by inspecting the result and
      // ensuring it never equals `aboveHome` even though no marker
      // exists in fakeHome itself.
      const projectDir = path.join(fakeHome, 'projects/myrepo/configs');
      await fs.mkdir(projectDir, { recursive: true });
      const originalHome = process.env.HOME;
      process.env.HOME = fakeHome;
      try {
        const root = findWorkspaceRoot(projectDir);
        // Walk must not have reached aboveHome or beyond.
        const rootReal = await fs.realpath(root);
        expect(rootReal === aboveHome).toBe(false);
        // For the same reason, the fallback should be configDir
        // (no marker in the chain up to $HOME).
        const projectDirReal = await fs.realpath(projectDir);
        expect(rootReal).toBe(projectDirReal);
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('returns a realpath-resolved result (symlinked configDir → canonical path)', async () => {
    // Some macOS setups symlink `/tmp` → `/private/tmp`. Whether or
    // not that's true on the runner, we set up an explicit symlink
    // and verify the result is the realpath, not the symlink.
    await fs.writeFile(path.join(tmp, 'nx.json'), '');
    const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-symlink-'));
    try {
      const link = path.join(linkParent, 'workspace-link');
      await fs.symlink(tmp, link);
      const root = findWorkspaceRoot(link);
      // The link itself isn't the realpath; the resolved path is.
      expect(root).toBe(tmp); // tmp is already realpath'd in beforeEach
    } finally {
      await fs.rm(linkParent, { recursive: true, force: true });
    }
  });
});
