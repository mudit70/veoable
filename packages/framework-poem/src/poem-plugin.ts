import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createPoemVisitor } from './visitor.js';

/**
 * Poem framework plugin (Phase 5d of #474).
 *
 * Detects routes declared via poem's builder API:
 *
 *   let app = Route::new()
 *       .at("/hello", get(handler))
 *       .at("/users/:id", post(create_user).put(update_user))
 *       .nest("/api", api_routes);
 *
 * Each `.at("/path", get(...)/post(...)/...)` emits one
 * `APIEndpoint` per HTTP method present in the second arg.
 *
 * Activation: `poem` crate in Cargo.toml. Per-file gate: `use poem`.
 */
export const POEM_PLUGIN_ID = 'poem' as const;

export class PoemPlugin implements FrameworkPlugin {
  readonly id = POEM_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'poem');
  }

  readonly visitor: RustFrameworkVisitor = createPoemVisitor();
}
