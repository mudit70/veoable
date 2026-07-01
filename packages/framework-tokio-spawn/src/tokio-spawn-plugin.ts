import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createTokioSpawnVisitor } from './visitor.js';

/**
 * tokio::spawn background-task plugin (#538).
 *
 * Recognises bare `tokio::spawn(...)` / `tokio::task::spawn(...)`
 * call sites and emits each as a `ClientSideProcess` so the spawn
 * site becomes a valid starting point for `walkAllProcesses`.
 *
 * Why this matters: `framework-apalis` (the queue-broker path)
 * already covers Redis/SQS-fed workers, but the simpler
 * `tokio::spawn(handler())` pattern — common for fire-and-forget
 * background work in async Rust services — produces no graph node
 * today. Flows that should reach a background DB write or HTTP
 * call dead-end at the spawn call site because `walkAllProcesses`
 * never starts there.
 *
 * The spawned future's BODY is already extracted by lang-rust —
 * the `CALLS_FUNCTION` edges connect the spawn-site function to
 * whatever the future transitively calls. The only new emission
 * is the process node itself, attributed to the enclosing
 * function so the existing BFS walks it like any other process.
 *
 * Detection signal: `tokio` in `Cargo.toml`. Per-call gate is in
 * the visitor: only `tokio::spawn(...)` / `tokio::task::spawn(...)`
 * match. `spawn_blocking` is intentionally excluded — it runs on
 * the blocking thread pool, usually for sync work, and treating
 * it as a process would surface a different category of node we
 * don't have a name for yet.
 */
export const TOKIO_SPAWN_PLUGIN_ID = 'tokio-spawn' as const;

export class TokioSpawnPlugin implements FrameworkPlugin {
  readonly id = TOKIO_SPAWN_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'tokio');
  }

  readonly visitor: RustFrameworkVisitor = createTokioSpawnVisitor();
}
