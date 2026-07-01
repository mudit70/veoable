import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createNextjsVisitor } from './visitor.js';
import { extractNextjsPages } from './page-routes.js';

export const NEXTJS_PLUGIN_ID = 'nextjs' as const;

export class NextjsPlugin implements FrameworkPlugin {
  readonly id = NEXTJS_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    if ('next' in deps) return true;
    // #328 — Medusa.js v2 uses the same `export const GET/POST = ...`
    // shape under `src/api/`. Activate this plugin so the visitor's
    // Medusa branch runs.
    if ('@medusajs/medusa' in deps || '@medusajs/framework' in deps) return true;
    return false;
  }

  /**
   * #198 PR3c — emit Screens for Next.js pages.
   * Both routers are scanned: App Router (`app/<seg>/page.<ext>`) and
   * Pages Router (`pages/<seg>.<ext>` excluding `_app`/`_document`/api).
   */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    return extractNextjsPages(ctx.rootDir, path.basename(ctx.rootDir));
  }

  readonly visitor: TsFrameworkVisitor = createNextjsVisitor();
}
