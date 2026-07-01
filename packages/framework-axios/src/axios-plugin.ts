import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createAxiosVisitor } from './visitor.js';

export const AXIOS_PLUGIN_ID = 'axios' as const;

export class AxiosPlugin implements FrameworkPlugin {
  readonly id = AXIOS_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'axios' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createAxiosVisitor();
}
