import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createGcsRsVisitor } from './visitor.js';

/**
 * GCS framework plugin — Rust `google-cloud-storage` crate.
 *
 * Final slice of the GCS quadfecta (TS + Python + Go already merged).
 * Mirrors their emit shape so the flow stitcher treats all four as the
 * same external object-storage system.
 *
 * Detection is request-struct based:
 *
 *   client.download_object(
 *       &GetObjectRequest {
 *           bucket: "my-bucket".to_string(),
 *           object: "my-key".to_string(),
 *           ..Default::default()
 *       }, ..
 *   ).await?;
 *
 *   client.upload_object(
 *       &UploadObjectRequest { bucket: "...".to_string(), .. },
 *       data, &upload_type,
 *   ).await?;
 *
 *   client.delete_object(&DeleteObjectRequest { bucket, object, .. }).await?;
 *
 * Activation: `google-cloud-storage` crate in any Cargo.toml.
 */
export const GCS_RS_PLUGIN_ID = 'gcs-rs' as const;

export class GcsRsPlugin implements FrameworkPlugin {
  readonly id = GCS_RS_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'google-cloud-storage');
  }

  readonly visitor: RustFrameworkVisitor = createGcsRsVisitor();
}
