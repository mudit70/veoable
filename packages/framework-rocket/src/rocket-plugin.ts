import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createRocketVisitor } from './visitor.js';

/**
 * Rocket framework plugin (#26).
 *
 * Detects API endpoints declared via Rocket attribute macros:
 *   #[get("/path/<id>")] fn handler(id: u32) -> String {}
 *
 * Activates when `rocket` is a Cargo dependency in any subpackage of
 * the project tree (#203).
 *
 * Disambiguation with Actix: Both use `#[get("/path")]` attribute syntax.
 * They are separated by (1) Cargo dependency check and (2) per-file
 * import check (`rocket` vs `actix_web`).
 */
export const ROCKET_PLUGIN_ID = 'rocket' as const;

export class RocketPlugin implements FrameworkPlugin {
  readonly id = ROCKET_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'rocket');
  }

  readonly visitor: RustFrameworkVisitor = createRocketVisitor();
}
