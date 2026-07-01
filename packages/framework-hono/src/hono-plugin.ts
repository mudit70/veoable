import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createHonoVisitor } from './visitor.js';

/**
 * Hono framework plugin (#31).
 *
 * Detects server-side API endpoints declared via Hono's Express-like
 * routing API (`app.get('/path', handler)`, etc.) and emits canonical
 * `APIEndpoint` nodes.
 *
 * Hono is an ultrafast web framework for the Edge. Its routing API is
 * essentially identical to Express: `app.get(path, ...handlers)`.
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const HONO_PLUGIN_ID = 'hono' as const;

export class HonoPlugin implements FrameworkPlugin {
  readonly id = HONO_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return 'hono' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createHonoVisitor();
}
