import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { createGocliVisitor } from './visitor.js';

/**
 * Go CLI framework plugin (#62).
 *
 * Detects client-side processes in Go CLI applications:
 *   - Cobra Command definitions → cli_command
 *   - main() function entry points → script_entry
 *
 * Active for all Go projects (Cobra detection is per-file via import check).
 */
export const GOCLI_PLUGIN_ID = 'gocli' as const;

export class GocliPlugin implements FrameworkPlugin {
  readonly id = GOCLI_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    return ctx.files.some((f) => f.endsWith('.go'));
  }

  readonly visitor: GoFrameworkVisitor = createGocliVisitor();
}
