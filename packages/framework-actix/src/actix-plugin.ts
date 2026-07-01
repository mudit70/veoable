import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createActixVisitor } from './visitor.js';

/**
 * Actix-web framework plugin (#24).
 *
 * Detects API endpoints declared via Actix-web attribute macros:
 *   #[get("/path")] async fn handler() -> impl Responder {}
 *   #[post("/path")] async fn handler() -> impl Responder {}
 *
 * Activates when Cargo.toml has `actix-web` as a dependency key.
 *
 * Disambiguation with Rocket: Both use `#[get("/path")]` attribute syntax.
 * They are separated by (1) Cargo.toml dependency check (`actix-web` vs
 * `rocket`) and (2) per-file import check (`actix_web` vs `rocket`).
 */
export const ACTIX_PLUGIN_ID = 'actix' as const;

export class ActixPlugin implements FrameworkPlugin {
  readonly id = ACTIX_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'actix-web');
  }

  readonly visitor: RustFrameworkVisitor = createActixVisitor();
}
