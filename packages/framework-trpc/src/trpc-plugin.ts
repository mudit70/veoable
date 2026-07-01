import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createTrpcVisitor } from './visitor.js';

export const TRPC_PLUGIN_ID = 'trpc' as const;

export class TrpcPlugin implements FrameworkPlugin {
  readonly id = TRPC_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return '@trpc/server' in deps || '@trpc/react-query' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createTrpcVisitor();
}
