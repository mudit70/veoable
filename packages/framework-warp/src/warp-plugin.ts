import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createWarpVisitor } from './visitor.js';

/**
 * Warp framework plugin (Phase 5c of #474).
 *
 * Detects routes declared via warp's macro + combinator API:
 *
 *   let hello = warp::path!("hello" / String)
 *       .and(warp::get())
 *       .and_then(handler);
 *
 *   let api = warp::path("api")
 *       .and(warp::path("v1"))
 *       .and(warp::post())
 *       .and_then(create);
 *
 * Each `warp::path!(...)` (or chain of `warp::path("...")` calls)
 * emits an `APIEndpoint`. HTTP method is inferred from
 * `.and(warp::get/post/...())` calls found in the enclosing
 * let-binding's source text. If none is found we emit `ALL`.
 *
 * Activation: `warp` crate in Cargo.toml. Per-file gate: `use warp`.
 */
export const WARP_PLUGIN_ID = 'warp' as const;

export class WarpPlugin implements FrameworkPlugin {
  readonly id = WARP_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'warp');
  }

  readonly visitor: RustFrameworkVisitor = createWarpVisitor();
}
