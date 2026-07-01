import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createBullmqVisitor } from './visitor.js';

export const BULLMQ_PLUGIN_ID = 'bullmq' as const;

export class BullmqPlugin implements FrameworkPlugin {
  readonly id = BULLMQ_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'bullmq' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createBullmqVisitor();
}
