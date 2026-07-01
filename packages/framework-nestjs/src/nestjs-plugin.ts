import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createNestjsVisitor } from './visitor.js';

export const NESTJS_PLUGIN_ID = 'nestjs' as const;

export class NestjsPlugin implements FrameworkPlugin {
  readonly id = NESTJS_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return '@nestjs/core' in deps || '@nestjs/common' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createNestjsVisitor();
}
