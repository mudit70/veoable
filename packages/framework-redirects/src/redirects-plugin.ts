import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { extractRedirects } from './parser.js';

/**
 * firebase.json / vercel.json redirect plugin (#198 PR3e).
 *
 * Project-level (`onProjectLoaded`) extraction only — there's no AST
 * walking required for static JSON config files. The plugin emits
 * Screen pairs + NAVIGATES_TO edges so existing flow tooling picks
 * up redirect chains automatically.
 *
 * `language` is set to `'ts'` because every project needs at least
 * one language plugin loaded; this plugin doesn't actually walk TS
 * files, but binding to the TS language plugin matches the
 * conventions of the rest of the framework plugins.
 */
export const REDIRECTS_PLUGIN_ID = 'redirects' as const;

export class RedirectsPlugin implements FrameworkPlugin {
  readonly id = REDIRECTS_PLUGIN_ID;
  readonly language = 'ts';

  /**
   * Returns true when the project root has a `firebase.json` or
   * `vercel.json` file. The orchestrator scans those at the root
   * because that's where hosting providers expect them.
   */
  appliesTo(ctx: ProjectContext): boolean {
    return (
      fs.existsSync(path.join(ctx.rootDir, 'firebase.json')) ||
      fs.existsSync(path.join(ctx.rootDir, 'vercel.json'))
    );
  }

  /** Parse redirects and emit Screens + NAVIGATES_TO edges. */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    return extractRedirects(ctx.rootDir, path.basename(ctx.rootDir));
  }

  /** No-op visitor — this plugin does no AST walking. */
  readonly visitor = {
    language: 'ts' as const,
    onNode(): void {},
  };
}
