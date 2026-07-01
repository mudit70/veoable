import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { createGcsGoVisitor } from './visitor.js';

/**
 * GCS framework plugin — Go `cloud.google.com/go/storage` SDK.
 *
 * Third slice of the GCS quadfecta (TS + Python already merged). Mirrors
 * their emit shape so the flow stitcher treats all three as the same
 * external object-storage system.
 *
 * Detection is fluent-chain based:
 *
 *   client.Bucket("b").Object("k").NewReader(ctx)     → GET    gs://b/k
 *   client.Bucket("b").Object("k").NewWriter(ctx)     → PUT    gs://b/k
 *   client.Bucket("b").Object("k").Delete(ctx)        → DELETE gs://b/k
 *   client.Bucket("b").Objects(ctx, nil)              → GET    gs://b/
 *   client.Bucket("b").Delete(ctx)                    → DELETE gs://b/
 *
 * Activation: `cloud.google.com/go/storage` in any go.mod.
 */
export const GCS_GO_PLUGIN_ID = 'gcs-go' as const;

export class GcsGoPlugin implements FrameworkPlugin {
  readonly id = GCS_GO_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    return hasGoModule(ctx, 'cloud.google.com/go/storage');
  }

  readonly visitor: GoFrameworkVisitor = createGcsGoVisitor();
}
