import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar from 'chokidar';
import { analyzeProject, type ProjectConfig } from './project.js';

/**
 * #294 Phase 1 — `adorable project watch`.
 *
 * Long-running command: subscribes to file events under each repo's
 * source root, debounces, then re-analyzes only the affected repos
 * in-place. Cross-repo stitching + post-analysis finalizers still
 * run on every cycle so the graph stays coherent.
 *
 * The MCP server reads the DB lazily on every tool call (verified
 * by #270 sweeps), so a Claude session sees the updated graph on
 * the next question — no restart required.
 *
 * Errors in a single re-analysis are logged and skipped; the watch
 * loop keeps running.
 */

const DEFAULT_DEBOUNCE_MS = 1000;

/** Directories we never watch — same set lang-ts excludes from extraction. */
const IGNORED_DIRS = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
];

export interface WatchOptions {
  /** Debounce window in ms between observing a change and re-analysing. */
  debounceMs?: number;
  /**
   * #294 — opt into incremental analyze on each cycle. The graph
   * still stays coherent (post-analysis finalizers + stitching run
   * every cycle); per-repo extraction is narrowed to the files that
   * actually changed since the last cycle. Highly recommended for
   * large repos.
   */
  incremental?: boolean;
  /**
   * #294 sub-PR 3 — on-demand mode. When true, file changes are
   * still tracked into the dirty set, but the debounce timer does
   * NOT auto-fire. Use `refreshNow()` on the returned handle to
   * trigger a refresh manually. Useful when the cost of re-analysis
   * is high (large repos) and the user wants to control timing —
   * typically wired to a 'r' keypress in the terminal.
   */
  onDemand?: boolean;
  /** Print per-cycle activity. */
  verbose?: boolean;
  /**
   * Test hook — invoked once each re-analysis cycle completes
   * (success OR failure). Receives the set of repo names that ran
   * and any error from the cycle. Production callers don't use this.
   */
  onCycleComplete?: (info: { repos: readonly string[]; error: Error | null }) => void;
}

/**
 * Handle returned from `watchProject`. `stop()` shuts down the
 * watcher; `refreshNow()` drains the dirty set (no-op when empty)
 * and runs an immediate re-analysis. `dirtyRepos()` lets a caller
 * peek at the pending change set for UI purposes.
 */
export interface WatchHandle {
  stop: () => Promise<void>;
  refreshNow: () => Promise<void>;
  dirtyRepos: () => readonly string[];
}

/**
 * Watch a project config and re-analyse on file changes. Resolves
 * when the watcher is fully wired up; the returned `stop` handle
 * cleans up. The watch loop itself runs indefinitely until `stop()`
 * is called or the process exits.
 */
export async function watchProject(
  configPath: string,
  opts: WatchOptions = {},
): Promise<WatchHandle> {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const log = (msg: string) => console.error(msg);
  const vlog = opts.verbose ? log : () => {};

  const absConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absConfigPath);
  let config: ProjectConfig;
  try {
    config = JSON.parse(fs.readFileSync(absConfigPath, 'utf-8')) as ProjectConfig;
  } catch (err) {
    throw new Error(`Failed to read project config: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!config.repos || config.repos.length === 0) {
    throw new Error('Project config has no repos');
  }

  // Map absolute repo path → repo name. Sorted longest-path-first so
  // nested repos resolve to the correct (innermost) entry.
  const repoByPath = config.repos
    .map((r) => ({ name: r.name, absPath: path.resolve(configDir, r.path) }))
    .sort((a, b) => b.absPath.length - a.absPath.length);

  // Set of repos with pending changes. Drained on each tick.
  const dirty = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let pendingAfterCurrent = false;
  // Track the in-flight analyze Promise so `stop()` can await it
  // before resolving. Without this, a SIGINT during a re-analysis
  // would let the process exit with an open SQLite transaction.
  let analyzing: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    if (analyzing) {
      // A cycle is already running. Mark that we should re-run after
      // it finishes so we don't drop the change that just landed.
      pendingAfterCurrent = true;
      return;
    }
    // Drain loop: each cycle picks up everything dirty at its
    // start, then loops back if changes landed during the cycle.
    // This unifies auto-fire and on-demand: in auto-fire the timer
    // re-arms via scheduleFlush anyway, but the loop is the only
    // safe path in on-demand mode where the timer is suppressed
    // (otherwise mid-cycle changes are silently held).
    do {
      pendingAfterCurrent = false;
      if (dirty.size === 0) return;
      const repos = [...dirty].sort();
      dirty.clear();
      const start = Date.now();
      const cycle = (async (): Promise<void> => {
        let cycleError: Error | null = null;
        try {
          await analyzeProject(absConfigPath, {
            onlyRepos: repos,
            verbose: opts.verbose,
            incremental: opts.incremental,
            // Per-repo progress: surface a `[N/M]` indicator so the
            // user knows the cycle is making progress on multi-repo
            // refreshes. Single-repo runs print the same lines for
            // consistency. Goes to stderr unconditionally — watch
            // mode is interactive so silence on a 30s cycle is the
            // opposite of what the user wants.
            onRepoStart: ({ name, index, total }) => {
              log(`  [${index}/${total}] ${name}…`);
            },
            onRepoEnd: ({ name, index, total, elapsedMs }) => {
              const s = (elapsedMs / 1000).toFixed(1);
              log(`  [${index}/${total}] ✓ ${name} (${s}s)`);
            },
          });
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          log(`✓ refreshed ${repos.join(', ')} (${elapsed}s)`);
        } catch (err) {
          cycleError = err instanceof Error ? err : new Error(String(err));
          log(`✗ re-analysis failed: ${cycleError.message}`);
        } finally {
          opts.onCycleComplete?.({ repos, error: cycleError });
        }
      })();
      analyzing = cycle;
      try {
        await cycle;
      } finally {
        analyzing = null;
      }
    } while (pendingAfterCurrent);
  };

  const scheduleFlush = (): void => {
    // On-demand mode: changes are tracked but the timer NEVER fires
    // automatically. Caller must invoke refreshNow() (or end the
    // session). Suppress the debounce setup so we don't keep
    // resetting an idle timer that will never fire.
    if (opts.onDemand) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // Best-effort; errors handled inside flush.
      void flush();
    }, debounceMs);
  };

  const matchRepoForPath = (changedPath: string): string | null => {
    const abs = path.resolve(changedPath);
    for (const r of repoByPath) {
      if (abs === r.absPath || abs.startsWith(r.absPath + path.sep)) {
        return r.name;
      }
    }
    return null;
  };

  const watcher = chokidar.watch(
    repoByPath.map((r) => r.absPath),
    {
      ignored: (filePath: string) => {
        // chokidar v4 ignored() is called with every path.
        const basename = path.basename(filePath);
        if (basename.startsWith('.') && basename !== '.' && basename !== '..') {
          // Hidden files / dirs — skip .git, .DS_Store, etc.
          return basename !== filePath; // allow the root path itself if it starts with .
        }
        return IGNORED_DIRS.includes(basename);
      },
      ignoreInitial: true,
      persistent: true,
    },
  );

  const onChange = (changedPath: string): void => {
    const repoName = matchRepoForPath(changedPath);
    if (!repoName) return;
    if (!dirty.has(repoName)) {
      vlog(`  · ${repoName}: ${path.relative(configDir, changedPath)}`);
    }
    dirty.add(repoName);
    scheduleFlush();
  };

  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('unlink', onChange);

  await new Promise<void>((resolve, reject) => {
    watcher.once('ready', () => resolve());
    watcher.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });

  log(`Watching ${repoByPath.length} repo(s) — ${repoByPath.map((r) => r.name).join(', ')}`);
  if (opts.onDemand) {
    log(`Mode: on-demand (press 'r' in terminal to refresh, or call refreshNow()); output DB: ${path.resolve(configDir, config.output)}`);
  } else {
    log(`Debounce: ${debounceMs}ms${opts.incremental ? '; incremental' : ''}; output DB: ${path.resolve(configDir, config.output)}`);
  }

  return {
    stop: async () => {
      if (timer) clearTimeout(timer);
      // Drain any in-flight analyze so SIGINT during re-analysis
      // doesn't leave the SQLite DB mid-transaction.
      if (analyzing) {
        try {
          await analyzing;
        } catch {
          /* errors already logged inside flush() */
        }
      }
      await watcher.close();
    },
    refreshNow: async () => {
      // Cancel any pending debounce so we don't double-fire after
      // the manual refresh completes.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // If a cycle is already in flight (auto-fire timer beat the
      // user, or another caller is already inside refreshNow), wait
      // for it to finish before our own pass. Otherwise the caller
      // returns from refreshNow before any analysis has settled.
      // The pendingAfterCurrent tag pulls fresh dirty changes that
      // landed during the in-flight cycle into the next flush pass.
      if (analyzing) {
        pendingAfterCurrent = true;
        try { await analyzing; } catch { /* errors logged inside flush */ }
      }
      await flush();
    },
    dirtyRepos: () => [...dirty].sort(),
  };
}
