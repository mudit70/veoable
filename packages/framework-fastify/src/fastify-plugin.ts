import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createFastifyVisitor } from './visitor.js';

/**
 * Fastify framework plugin (#17, #110).
 *
 * Detects server-side API endpoints declared via the Fastify routing
 * API and emits canonical `APIEndpoint` nodes.
 *
 * Supported patterns:
 *   - `fastify.get('/path', handler)`
 *   - `fastify.get('/path', { handler })`
 *   - `fastify.get('/path', opts, handler)`
 *   - `app.get(...)`, `server.get(...)`, `instance.get(...)`
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const FASTIFY_PLUGIN_ID = 'fastify' as const;

export class FastifyPlugin implements FrameworkPlugin {
  readonly id = FASTIFY_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return 'fastify' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createFastifyVisitor();
}
