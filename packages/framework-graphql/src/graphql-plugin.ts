import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createGraphqlVisitor } from './visitor.js';

export const GRAPHQL_PLUGIN_ID = 'graphql' as const;

export class GraphqlPlugin implements FrameworkPlugin {
  readonly id = GRAPHQL_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return '@apollo/server' in deps || 'apollo-server' in deps
      || 'apollo-server-express' in deps || 'graphql-yoga' in deps
      || '@nestjs/graphql' in deps || 'graphql' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createGraphqlVisitor();
}
