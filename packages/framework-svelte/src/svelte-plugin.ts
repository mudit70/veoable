import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createSvelteVisitor } from './visitor.js';
import { extractSveltePages } from './page-routes.js';

/**
 * Svelte/SvelteKit framework plugin (#59).
 *
 * Detects client-side processes in Svelte/SvelteKit TypeScript source:
 *   - Svelte lifecycle hooks (onMount, onDestroy, beforeUpdate, afterUpdate)
 *   - SvelteKit load functions (+page.ts, +page.server.ts)
 *   - SvelteKit form actions (+page.server.ts)
 *   - Svelte store subscriptions (subscribe calls)
 *
 * Note: `.svelte` files contain template syntax that the TS language
 * plugin cannot parse directly. This plugin focuses on patterns in
 * `.ts` files (SvelteKit route modules, stores, etc.) and Svelte
 * lifecycle hooks imported from 'svelte' and called in TS files.
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const SVELTE_PLUGIN_ID = 'svelte' as const;

export class SveltePlugin implements FrameworkPlugin {
  readonly id = SVELTE_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return 'svelte' in deps || '@sveltejs/kit' in deps;
  }

  /**
   * #198 PR3c — emit Screens for every SvelteKit page under
   * `src/routes/`.
   */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    return extractSveltePages(ctx.rootDir, path.basename(ctx.rootDir));
  }

  readonly visitor: TsFrameworkVisitor = createSvelteVisitor();
}
