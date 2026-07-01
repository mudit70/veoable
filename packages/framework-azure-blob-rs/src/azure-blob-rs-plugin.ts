import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createAzureBlobRsVisitor } from './visitor.js';

/**
 * Azure Blob framework plugin — Rust `azure_storage_blobs` crate.
 *
 * Final slice of the Azure Blob quadfecta (TS + Python + Go merged).
 * Mirrors their emit shape so the flow stitcher treats all four as
 * the same external object-storage system.
 *
 * Detection is fluent-chain based:
 *
 *   use azure_storage_blobs::prelude::*;
 *   let blob_service = BlobServiceClient::new(account, creds);
 *   blob_service.container_client("c").blob_client("k").get().await?;
 *   blob_service.container_client("c").blob_client("k").put_block_blob(b).await?;
 *   blob_service.container_client("c").blob_client("k").delete().await?;
 *   blob_service.container_client("c").list_blobs().execute().await?;
 *   blob_service.container_client("c").delete().await?;
 *
 * Activation: `azure_storage_blobs` crate in any Cargo.toml.
 */
export const AZURE_BLOB_RS_PLUGIN_ID = 'azure-blob-rs' as const;

export class AzureBlobRsPlugin implements FrameworkPlugin {
  readonly id = AZURE_BLOB_RS_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'azure_storage_blobs') || hasCargoCrate(ctx, 'azure-storage-blobs');
  }

  readonly visitor: RustFrameworkVisitor = createAzureBlobRsVisitor();
}
