import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasPythonPackage } from '@adorable/plugin-api';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { createFlaskVisitor } from './visitor.js';

export const FLASK_PLUGIN_ID = 'flask' as const;

export class FlaskPlugin implements FrameworkPlugin {
  readonly id = FLASK_PLUGIN_ID;
  readonly language = 'py';

  /**
   * Activates when `flask` is declared in any Python manifest under
   * the project tree (#203).
   */
  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'flask');
  }

  readonly visitor: PyFrameworkVisitor = createFlaskVisitor();
}
