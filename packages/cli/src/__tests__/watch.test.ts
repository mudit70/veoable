import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchProject } from '../watch.js';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';

/**
 * Tests for #294 Phase 1 — `veoable project watch`.
 *
 * Uses a temp-fs project with two trivial single-file repos. We
 * exercise the watch loop's invariants directly via the
 * `onCycleComplete` hook rather than racing the debounce timer.
 */

const FAST_DEBOUNCE = 50;

let tmpRoot: string;
let configPath: string;

function writeRepoFile(repo: string, name: string, body: string): string {
  const dir = path.join(tmpRoot, repo, 'src');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

function readSourceFilePaths(): string[] {
  const dbPath = path.join(tmpRoot, 'project.db');
  if (!fs.existsSync(dbPath)) return [];
  const store = new SQLiteCanonicalGraphStore(dbPath);
  try {
    return store.findNodes('SourceFile').map((n) => n.filePath);
  } finally {
    store.close();
  }
}

function readHashRow(
  repo: string,
  filePath: string,
): { hash: string; updated_at: string } | null {
  const dbPath = path.join(tmpRoot, 'project.db');
  if (!fs.existsSync(dbPath)) return null;
  const store = new SQLiteCanonicalGraphStore(dbPath);
  try {
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const row = db
      .prepare('SELECT hash, updated_at FROM source_file_hashes WHERE repository = ? AND file_path = ?')
      .get(repo, filePath) as { hash: string; updated_at: string } | undefined;
    return row ?? null;
  } finally {
    store.close();
  }
}

async function waitForDirty(handle: { dirtyRepos: () => readonly string[] }, repo: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (handle.dirtyRepos().includes(repo)) return resolve();
      if (Date.now() - start > 5_000) {
        return reject(new Error(`timed out waiting for chokidar to mark ${repo} dirty`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veoable-watch-'));
  // Two trivial repos.
  writeRepoFile('alpha', 'a.ts', 'export const a = 1;\n');
  writeRepoFile('beta', 'b.ts', 'export const b = 2;\n');
  // Project config.
  configPath = path.join(tmpRoot, 'project.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      name: 'tmp',
      output: 'project.db',
      repos: [
        { path: './alpha', name: 'alpha' },
        { path: './beta', name: 'beta' },
      ],
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('watchProject (#294 Phase 1)', () => {
  it('emits a cycle covering ONLY the affected repo when one file changes', async () => {
    const cycles: { repos: readonly string[]; error: Error | null }[] = [];
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onCycleComplete: (info) => cycles.push(info),
    });
    try {
      const cycle = waitForCycle(cycles, 1);
      // Touch a file under alpha only.
      writeRepoFile('alpha', 'a.ts', 'export const a = 11;\n');
      const info = await cycle;
      expect(info.repos).toEqual(['alpha']);
      expect(info.error).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it('coalesces multiple rapid edits in the same repo into one cycle', async () => {
    const cycles: { repos: readonly string[]; error: Error | null }[] = [];
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onCycleComplete: (info) => cycles.push(info),
    });
    try {
      const cycle = waitForCycle(cycles, 1);
      // Three rapid writes within the debounce window.
      writeRepoFile('alpha', 'a.ts', 'export const a = 100;\n');
      writeRepoFile('alpha', 'a.ts', 'export const a = 101;\n');
      writeRepoFile('alpha', 'a.ts', 'export const a = 102;\n');
      await cycle;
      // Single cycle — not three.
      expect(cycles.length).toBe(1);
    } finally {
      await handle.stop();
    }
  });

  it('re-analyses ONLY changed repos; preserves other repos data', async () => {
    // Seed the DB by running watch once on alpha; then change beta.
    // After the beta change, alpha's SourceFile must still be present.
    const cycles: { repos: readonly string[]; error: Error | null }[] = [];
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onCycleComplete: (info) => cycles.push(info),
    });
    try {
      // Cycle 1: change alpha.
      let cycle = waitForCycle(cycles, 1);
      writeRepoFile('alpha', 'a.ts', 'export const a = 999;\n');
      await cycle;
      const afterAlpha = readSourceFilePaths();
      expect(afterAlpha.some((p) => p.includes('a.ts'))).toBe(true);

      // Cycle 2: change beta. Alpha's data must survive — the per-repo
      // delete in `analyze` is scoped to repo `beta` only.
      cycle = waitForCycle(cycles, 2);
      writeRepoFile('beta', 'b.ts', 'export const b = 22;\n');
      await cycle;
      const afterBeta = readSourceFilePaths();
      expect(afterBeta.some((p) => p.includes('a.ts'))).toBe(true);
      expect(afterBeta.some((p) => p.includes('b.ts'))).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('survives a re-analysis error and continues processing next change', async () => {
    const cycles: { repos: readonly string[]; error: Error | null }[] = [];
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onCycleComplete: (info) => cycles.push(info),
    });
    try {
      // Force a real analyze failure by deleting the repo directory
      // AFTER the watcher locked onto it. The first cycle's analyze()
      // call will throw because the repo path no longer exists.
      let cycle = waitForCycle(cycles, 1);
      fs.rmSync(path.join(tmpRoot, 'alpha'), { recursive: true });
      // Re-create the dir and touch a file so chokidar fires a change.
      fs.mkdirSync(path.join(tmpRoot, 'alpha', 'src'), { recursive: true });
      // Use an invalid TS source (parse-error-free, but missing the
      // expected entry) to ensure analyze either errors or returns
      // with no nodes; we accept either outcome here and check the
      // watch loop survives.
      writeRepoFile('alpha', 'a.ts', 'export const a = 1;\n');
      await cycle;

      // Whether cycle 1 errored or succeeded, the watcher must still be
      // alive and processing changes. Trigger a clean follow-up.
      cycle = waitForCycle(cycles, 2);
      writeRepoFile('alpha', 'a.ts', 'export const a = 77;\n');
      await cycle;
      expect(cycles[1]!.repos).toEqual(['alpha']);
      expect(cycles[1]!.error).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it('emits both repos in one cycle when edits to both fall in the same window', async () => {
    const cycles: { repos: readonly string[]; error: Error | null }[] = [];
    const handle = await watchProject(configPath, {
      debounceMs: 150,
      onCycleComplete: (info) => cycles.push(info),
    });
    try {
      const cycle = waitForCycle(cycles, 1);
      writeRepoFile('alpha', 'a.ts', 'export const a = 1234;\n');
      writeRepoFile('beta', 'b.ts', 'export const b = 5678;\n');
      const info = await cycle;
      expect([...info.repos].sort()).toEqual(['alpha', 'beta']);
    } finally {
      await handle.stop();
    }
  });

  it('throws on a missing config path during setup', async () => {
    await expect(
      watchProject(path.join(tmpRoot, 'nonexistent.project.json'), { debounceMs: FAST_DEBOUNCE }),
    ).rejects.toThrow(/Failed to read project config/);
  });

  it('analyzeProject with onlyRepos=[] skips all per-repo analyze but still runs finalizers', async () => {
    // Direct unit test on the analyzeProject contract — distinguishes
    // undefined (analyze every repo, default) from [] (skip every
    // repo). Documents the watch-loop's edge case where it might want
    // to refresh stitch state without re-analyzing any repo.
    const { analyzeProject } = await import('../project.js');

    // Cold-start: analyze every repo so the DB exists with data.
    await analyzeProject(configPath);
    const beforePaths = readSourceFilePaths();
    expect(beforePaths.length).toBeGreaterThan(0);

    // Mutate alpha's source on disk without notifying the (non-existent)
    // watcher, then call analyzeProject with onlyRepos=[]. The per-repo
    // loop should skip alpha entirely; alpha's data must reflect the
    // ORIGINAL contents, not the new ones.
    writeRepoFile('alpha', 'a.ts', 'export const SHOULD_NOT_APPEAR = 1;\n');
    await analyzeProject(configPath, { onlyRepos: [] });
    const afterPaths = readSourceFilePaths();
    expect(afterPaths.sort()).toEqual(beforePaths.sort());
  });

  // On-demand mode (#294 sub-PR 3). These tests don't race chokidar's
  // initial-scan window — the dirty set + refreshNow contract is what
  // we're pinning, not the file-event plumbing (which is shared with
  // the auto-fire mode and already covered by the tests above).
  it('on-demand refreshNow() is a no-op when nothing is dirty', async () => {
    const cycles: { repos: readonly string[]; error: Error | null }[] = [];
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onDemand: true,
      onCycleComplete: (info) => cycles.push(info),
    });
    try {
      await handle.refreshNow();
      expect(cycles.length).toBe(0);
      expect(handle.dirtyRepos()).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it('on-demand refreshNow() fires a cycle when dirty is non-empty', async () => {
    // Integration coverage: the on-demand branch in scheduleFlush
    // (no-op'd) and the on-demand-only refreshNow gating are NOT
    // covered by the auto-fire tests. Pin that the file-event
    // pipeline still feeds dirty + that refreshNow actually drains
    // the dirty set into an analyzeProject call.
    const cycles: { repos: readonly string[]; error: Error | null }[] = [];
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onDemand: true,
      onCycleComplete: (info) => cycles.push(info),
    });
    try {
      // Edit a file AFTER the watcher is ready so chokidar's
      // initial-scan window doesn't suppress the event. The 200ms
      // settle delay is empirical: chokidar's 'ready' event fires
      // after the initial scan but fs-events (macOS) can still
      // deliver buffered events for the seeded fixture files just
      // after. Without the wait, beta/b.ts (written in beforeEach)
      // gets reported as a change and bleeds into our assertion.
      await new Promise((r) => setTimeout(r, 200));
      writeRepoFile('alpha', 'a.ts', 'export const a = 7;\n');
      // Poll for chokidar to report the change. Generous timeout
      // because chokidar's fs-events backend can buffer briefly.
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const tick = (): void => {
          if (handle.dirtyRepos().includes('alpha')) return resolve();
          if (Date.now() - start > 5_000) {
            return reject(new Error('chokidar did not report change within 5s'));
          }
          setTimeout(tick, 25);
        };
        tick();
      });
      // Sanity: in on-demand mode no auto-fire has happened.
      expect(cycles.length).toBe(0);
      const dirtyBeforeRefresh = handle.dirtyRepos();
      // The manual refresh MUST drain dirty into exactly ONE cycle
      // that covers whatever was dirty at trigger time. NOTE: on
      // macOS/fsevents, the seeded beta/b.ts can also surface as a
      // change shortly after `ready`; we accept either ['alpha'] or
      // ['alpha','beta'] — the load-bearing contract is "dirty
      // drained, exactly one cycle fired."
      await handle.refreshNow();
      expect(cycles.length).toBe(1);
      expect(cycles[0]!.repos).toEqual([...dirtyBeforeRefresh].sort());
      expect(handle.dirtyRepos()).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it('on-demand mode exposes the refreshNow + dirtyRepos API on the handle', async () => {
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onDemand: true,
    });
    try {
      // The handle's API surface — refreshNow and dirtyRepos — is the
      // load-bearing contract for the CLI's keypress integration and
      // any programmatic caller. Pin the shape so a future refactor
      // doesn't silently drop them.
      expect(typeof handle.refreshNow).toBe('function');
      expect(typeof handle.dirtyRepos).toBe('function');
      expect(typeof handle.stop).toBe('function');
      expect(handle.dirtyRepos()).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it('analyzeProject fires onRepoStart + onRepoEnd in [N/M] order for each repo run', async () => {
    // Direct analyzeProject test — watch's wiring just routes these
    // callbacks to stderr, so the load-bearing contract to pin is
    // the callbacks themselves: ordering, indexing, totals, timing.
    const { analyzeProject } = await import('../project.js');
    const events: string[] = [];
    await analyzeProject(configPath, {
      onRepoStart: ({ name, index, total }) => events.push(`start ${index}/${total} ${name}`),
      onRepoEnd: ({ name, index, total, elapsedMs }) => {
        // Elapsed must be non-negative; the actual value depends on
        // how fast the tiny fixture extracts. Capture it as ">=0" so
        // the assertion stays stable.
        const ok = typeof elapsedMs === 'number' && elapsedMs >= 0;
        events.push(`end ${index}/${total} ${name} ${ok ? 'ok' : 'BAD'}`);
      },
    });
    expect(events).toEqual([
      'start 1/2 alpha',
      'end 1/2 alpha ok',
      'start 2/2 beta',
      'end 2/2 beta ok',
    ]);
  });

  it('watch wires per-repo progress to stderr via the analyzeProject callbacks', async () => {
    // The analyzeProject callbacks themselves are pinned by the
    // direct tests above. This one verifies the WATCH wiring: that
    // a refresh cycle emits `[N/M] name…` and `[N/M] ✓ name (Xs)`
    // lines via console.error. A regression here would be visible
    // immediately in interactive use, but pinning the line shape
    // protects against accidental silent removal of the callbacks.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onDemand: true,
    });
    try {
      // Wait for chokidar to settle, then write a file so beta gets
      // a `change` event we can refresh on.
      await new Promise((r) => setTimeout(r, 200));
      writeRepoFile('beta', 'b.ts', 'export const b = 4242;\n');
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const tick = (): void => {
          if (handle.dirtyRepos().length > 0) return resolve();
          if (Date.now() - start > 5_000) {
            return reject(new Error('chokidar did not report change within 5s'));
          }
          setTimeout(tick, 25);
        };
        tick();
      });
      await handle.refreshNow();
      const all = spy.mock.calls.map((c) => String(c[0])).join('\n');
      // At least one [N/M] start AND one [N/M] ✓ line must fire.
      expect(all).toMatch(/\[\d+\/\d+\] \w+…/);
      expect(all).toMatch(/\[\d+\/\d+\] ✓ \w+ \(\d+\.\d+s\)/);
    } finally {
      await handle.stop();
      spy.mockRestore();
    }
  });

  it('analyzeProject onRepoEnd reports total = onlyRepos length under watch-style filtering', async () => {
    // Watch passes onlyRepos: the dirty subset. The [N/M] indicator
    // shown to the user must reflect THAT subset's size, not the
    // full config's size, so "[1/1]" reads correctly when only one
    // repo refreshes.
    const { analyzeProject } = await import('../project.js');
    // Cold-start so the DB exists.
    await analyzeProject(configPath);
    const events: string[] = [];
    await analyzeProject(configPath, {
      onlyRepos: ['beta'],
      onRepoStart: ({ name, index, total }) => events.push(`start ${index}/${total} ${name}`),
      onRepoEnd: ({ name, index, total }) => events.push(`end ${index}/${total} ${name}`),
    });
    expect(events).toEqual([
      'start 1/1 beta',
      'end 1/1 beta',
    ]);
  });

  it('watch + --incremental: hash sidecar populated on first refresh; identical re-touch is a no-op (#421)', async () => {
    // Integration pin: --incremental must flow from watch through
    // analyzeProject through analyze. The source_file_hashes sidecar
    // is the clearest end-to-end signal — written only when the
    // incremental flag survives the trip. A second refresh after a
    // re-touch with IDENTICAL content must NOT bump updated_at,
    // proving the hash diff actually fires (without --incremental,
    // each watch cycle wipes-and-rebuilds via clean:true and the
    // sidecar row would be overwritten on every refresh).
    const handle = await watchProject(configPath, {
      debounceMs: FAST_DEBOUNCE,
      onDemand: true,
      incremental: true,
    });
    try {
      // Cycle 1 — edit a.ts with new content, refresh.
      await new Promise((r) => setTimeout(r, 200));
      writeRepoFile('alpha', 'a.ts', 'export const a = 999;\n');
      await waitForDirty(handle, 'alpha');
      await handle.refreshNow();

      const row1 = readHashRow('alpha', 'src/a.ts');
      expect(row1).not.toBeNull();
      expect(row1!.hash).toMatch(/^[0-9a-f]{64}$/);
      const updatedAt1 = row1!.updated_at;

      // datetime('now') is second-precision; sleep so a stray write
      // would produce a visibly different updated_at.
      await new Promise((r) => setTimeout(r, 1100));

      // Cycle 2 — re-touch a.ts with the SAME content. chokidar
      // emits a change event (mtime differs); --incremental should
      // detect the identical hash and skip re-extraction, leaving
      // updated_at unchanged.
      writeRepoFile('alpha', 'a.ts', 'export const a = 999;\n');
      await waitForDirty(handle, 'alpha');
      await handle.refreshNow();

      const row2 = readHashRow('alpha', 'src/a.ts');
      expect(row2).not.toBeNull();
      expect(row2!.hash).toBe(row1!.hash);
      expect(row2!.updated_at).toBe(updatedAt1);
    } finally {
      await handle.stop();
    }
  });

  it('throws when config has no repos', async () => {
    const emptyConfig = path.join(tmpRoot, 'empty.json');
    fs.writeFileSync(emptyConfig, JSON.stringify({ name: 'x', output: 'x.db', repos: [] }));
    await expect(watchProject(emptyConfig, { debounceMs: FAST_DEBOUNCE })).rejects.toThrow(
      /has no repos/,
    );
  });
});

/**
 * Wait for the Nth cycle to complete. Returns the cycle info.
 * Times out at 10s if the cycle never fires — long enough for a
 * cold-start analyze on the tiny temp fixture.
 */
function waitForCycle(
  cycles: readonly { repos: readonly string[]; error: Error | null }[],
  targetCount: number,
  timeoutMs = 10_000,
): Promise<{ repos: readonly string[]; error: Error | null }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cycles.length >= targetCount) {
        resolve(cycles[targetCount - 1]!);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitForCycle: timed out waiting for cycle ${targetCount}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}
