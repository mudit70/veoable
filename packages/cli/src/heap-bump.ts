import { spawnSync } from 'node:child_process';

/**
 * Re-exec the CLI under a larger V8 heap when the user didn't specify
 * one (#181).
 *
 * Default Node's `max-old-space-size` is computed from system RAM but
 * can be as low as ~1.7 GB on machines with ≤8 GB. ts-morph keeps a
 * full AST per source file in memory for cross-file resolution, and
 * veoable plus its language plugins easily exceed that on
 * mid-to-large monorepos. Without intervention the run dies with
 * "Ineffective mark-compacts near heap limit" and a stack trace
 * users have no easy way to interpret.
 *
 * V8 cannot resize the old-space heap after process start, so the
 * only deterministic fix is to respawn. The respawn cost
 * (~50-100ms) is dwarfed by even a small analysis run.
 *
 * The heuristics:
 *   - Run the bump only when `process.argv[1]` looks like the
 *     veoable CLI entry point. Programmatic imports (tests,
 *     library consumers) must not trigger respawn.
 *   - Respect any heap flag the user already set, via
 *     `process.execArgv` or `NODE_OPTIONS`.
 *   - Honor `ADORABLE_NO_HEAP_BUMP=1` as an explicit opt-out.
 *   - Default budget is 8 GB; override via `ADORABLE_HEAP_MB` if a
 *     user wants something different (e.g. constrained CI runners).
 *
 * On respawn the original `argv`, `cwd`, and stdio are preserved so
 * the child process is observationally identical to running with the
 * heap flag from the start.
 */
const HEAP_FLAG_RX = /max-old-space-size/i;

export interface HeapBumpDecision {
  /** Whether ensureHeap should respawn the process. */
  shouldRespawn: boolean;
  /** When `shouldRespawn`, the heap size in MB to pass on respawn. */
  heapMb: number;
  /** Human-readable reason — useful in tests and diagnostics. */
  reason: string;
}

export function decideHeapBump(env: NodeJS.ProcessEnv, execArgv: readonly string[], argv: readonly string[]): HeapBumpDecision {
  const heapMb = parseHeapMb(env.ADORABLE_HEAP_MB) ?? 8192;
  const entry = argv[1] ?? '';
  if (!isCliEntryPoint(entry)) {
    return { shouldRespawn: false, heapMb, reason: 'not running as CLI entry point' };
  }
  if (env.ADORABLE_NO_HEAP_BUMP === '1') {
    return { shouldRespawn: false, heapMb, reason: 'ADORABLE_NO_HEAP_BUMP=1' };
  }
  if (execArgv.some((a) => HEAP_FLAG_RX.test(a))) {
    return { shouldRespawn: false, heapMb, reason: 'execArgv already has --max-old-space-size' };
  }
  if (splitNodeOptions(env.NODE_OPTIONS).some((a) => HEAP_FLAG_RX.test(a))) {
    return { shouldRespawn: false, heapMb, reason: 'NODE_OPTIONS already has --max-old-space-size' };
  }
  return { shouldRespawn: true, heapMb, reason: `respawning with --max-old-space-size=${heapMb}` };
}

/**
 * Apply the heap bump if needed. When the function returns, either
 * the heap is sized appropriately or the call was a no-op (we're
 * already running with the right flag, or the entry point is not
 * the CLI). When a respawn happens this function does not return —
 * it `process.exit`s with the child's status code.
 */
export function ensureHeap(): void {
  const decision = decideHeapBump(process.env, process.execArgv, process.argv);
  if (!decision.shouldRespawn) return;
  const args = [
    `--max-old-space-size=${decision.heapMb}`,
    ...process.execArgv,
    ...process.argv.slice(1),
  ];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function isCliEntryPoint(entry: string): boolean {
  // Linked binaries from pnpm/npm point at one of:
  //   - …/dist/cli.js (direct invocation)
  //   - …/.bin/veoable (symlink)
  // We accept either; tests' importing path (`…/__tests__/foo.test.ts`)
  // never matches.
  return /(?:^|[/\\])(?:cli\.js|veoable)$/.test(entry);
}

function parseHeapMb(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitNodeOptions(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean);
}
