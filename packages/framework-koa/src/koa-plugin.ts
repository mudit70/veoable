import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createKoaVisitor } from './visitor.js';

/**
 * Koa framework plugin (#27).
 *
 * Detects server-side API endpoints declared via koa-router
 * (`router.get('/path', handler)`, etc.) and emits canonical
 * `APIEndpoint` nodes.
 *
 * Koa routing via koa-router / @koa/router follows the same
 * `router.METHOD(path, ...middleware, handler)` pattern as Express
 * but with a constructor prefix (`new Router({ prefix: '/api' })`).
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const KOA_PLUGIN_ID = 'koa' as const;

export class KoaPlugin implements FrameworkPlugin {
  readonly id = KOA_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return 'koa' in deps || '@koa/router' in deps || 'koa-router' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createKoaVisitor();
}
