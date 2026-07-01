import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { extractBundles, findBundlerConfigs } from './parser.js';

/**
 * Bundler-config plugin (#197).
 *
 * Discovers webpack/vite/rollup/esbuild config files, extracts the
 * `entry` map + output filename pattern, and emits SourceFile +
 * BUNDLES_TO edges so lang-html's `<script src>` resolution can
 * cross from a bundle filename to the entry source.
 *
 * Project-level emission only — no AST walking required at the
 * file level.
 */
export const BUNDLER_PLUGIN_ID = 'bundler' as const;

export class BundlerPlugin implements FrameworkPlugin {
  readonly id = BUNDLER_PLUGIN_ID;
  readonly language = 'ts';

  /**
   * Returns true when at least one recognized bundler config file
   * is present at the project root or one level deep.
   */
  appliesTo(ctx: ProjectContext): boolean {
    return findBundlerConfigs(ctx.rootDir).length > 0;
  }

  /** Parse all bundler configs and emit SourceFile + BUNDLES_TO edges. */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    return extractBundles(ctx.rootDir, path.basename(ctx.rootDir));
  }

  /** No-op visitor — project-level extraction only. */
  readonly visitor = {
    language: 'ts' as const,
    onNode(): void {},
  };
}
