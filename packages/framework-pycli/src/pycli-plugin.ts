import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { createPycliVisitor } from './visitor.js';

/**
 * Python CLI framework plugin (#62).
 *
 * Detects client-side processes in Python CLI/script applications:
 *   - Click @cli.command() decorators → cli_command
 *   - Typer @app.command() decorators → cli_command
 *   - if __name__ == '__main__' blocks → script_entry
 *
 * Always active for Python projects since click/typer are detected
 * per-file via decorator patterns.
 */
export const PYCLI_PLUGIN_ID = 'pycli' as const;

export class PycliPlugin implements FrameworkPlugin {
  readonly id = PYCLI_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return ctx.files.some((f) => f.endsWith('.py'));
  }

  readonly visitor: PyFrameworkVisitor = createPycliVisitor();
}
