import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createRemixVisitor } from './visitor.js';
import { extractRemixPages } from './page-routes.js';

/**
 * Remix framework plugin (#31).
 *
 * Detects server-side API endpoints declared via Remix's file-system
 * routing convention and exported `loader` / `action` functions.
 *
 * Route files live under `app/routes/` and follow the Remix v2 flat
 * file convention:
 *   - `.` → path separator (`users.tsx` → `/users`)
 *   - `$` → dynamic segment (`$id.tsx` → `/:id`)
 *   - `_` prefix → pathless layout (`_auth.login.tsx` → `/login`)
 *   - `_index` → index route
 *
 * Each route file may export:
 *   - `loader` → GET endpoint
 *   - `action` → POST/PUT/DELETE endpoint
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const REMIX_PLUGIN_ID = 'remix' as const;

export class RemixPlugin implements FrameworkPlugin {
  readonly id = REMIX_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return '@remix-run/node' in deps || '@remix-run/react' in deps || '@remix-run/deno' in deps || '@remix-run/cloudflare' in deps;
  }

  /**
   * #198 PR3c — emit Screens for every Remix route file under
   * `app/routes/`.
   */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    return extractRemixPages(ctx.rootDir, path.basename(ctx.rootDir));
  }

  readonly visitor: TsFrameworkVisitor = createRemixVisitor();
}
