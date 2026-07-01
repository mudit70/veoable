import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createGcsTsVisitor } from './visitor.js';

/**
 * Google Cloud Storage (TypeScript / Node) framework plugin.
 *
 * First slice of the GCS quadfecta (TS, Python, Go, Rust). Mirrors the
 * AWS S3 quadfecta emit shape so the flow stitcher treats them as the
 * same kind of external object-storage system.
 *
 * Targets the official `@google-cloud/storage` SDK, which uses a fluent
 * builder pattern (NOT command objects):
 *
 *   import { Storage } from '@google-cloud/storage';
 *   const storage = new Storage();
 *   await storage.bucket('my-bucket').file('k').download();
 *   await storage.bucket('my-bucket').file('k').save(buf);
 *   await storage.bucket('my-bucket').upload('/path');
 *   await storage.bucket('my-bucket').file('k').delete();
 *
 * Activation: `@google-cloud/storage` in package.json (deps OR
 * devDependencies). Per-file gate: any import from
 * `@google-cloud/storage`.
 */
export const GCS_TS_PLUGIN_ID = 'gcs-ts' as const;

export class GcsTsPlugin implements FrameworkPlugin {
  readonly id = GCS_TS_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return '@google-cloud/storage' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createGcsTsVisitor();
}
