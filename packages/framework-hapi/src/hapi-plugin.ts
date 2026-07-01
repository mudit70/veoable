import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createHapiVisitor } from './visitor.js';

/**
 * Hapi framework plugin (#27).
 *
 * Detects server-side API endpoints declared via `server.route()`
 * and emits canonical `APIEndpoint` nodes.
 *
 * Hapi uses a declarative route configuration:
 *   server.route({ method: 'GET', path: '/users', handler })
 *   server.route([{ method: 'GET', path: '/' }, ...])
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const HAPI_PLUGIN_ID = 'hapi' as const;

export class HapiPlugin implements FrameworkPlugin {
  readonly id = HAPI_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return '@hapi/hapi' in deps || 'hapi' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createHapiVisitor();
}
