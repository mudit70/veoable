import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createVueVisitor } from './visitor.js';
import { extractNuxtScreens } from './nuxt-pages.js';

export const VUE_PLUGIN_ID = 'vue' as const;

export class VuePlugin implements FrameworkPlugin {
  readonly id = VUE_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'vue' in deps || 'nuxt' in deps;
  }

  /**
   * #370 — Discover Nuxt 3 `pages/**\/*.vue` files and emit Screen
   * nodes. Nuxt's file-based router uses the same bracketed
   * dynamic-segment syntax as Next.js; `extractNuxtScreens`
   * mirrors the Next.js extractor for `.vue` files.
   *
   * Only fires when the project declares Nuxt — plain Vue SPAs
   * use Vue Router config (#TBD) rather than file-based routes.
   */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    if (!('nuxt' in deps)) return { nodes: [], edges: [] };
    const repository = path.basename(ctx.rootDir);
    return extractNuxtScreens(ctx.rootDir, repository);
  }

  readonly visitor: TsFrameworkVisitor = createVueVisitor();
}
