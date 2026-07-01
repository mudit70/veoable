import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createAzureBlobTsVisitor } from './visitor.js';

/**
 * Azure Blob Storage (TypeScript / Node) framework plugin.
 *
 * First slice of the Azure Blob quadfecta (TS, Python, Go, Rust).
 * Mirrors the AWS S3 / GCS quadfecta emit shape so the flow stitcher
 * treats them as the same kind of external object-storage system.
 *
 * Targets `@azure/storage-blob` — the official Azure SDK for Node:
 *
 *   import { BlobServiceClient } from '@azure/storage-blob';
 *   const svc = BlobServiceClient.fromConnectionString(connStr);
 *   const container = svc.getContainerClient('my-container');
 *   const blob = container.getBlobClient('my-blob');
 *   await blob.download();
 *   await container.getBlockBlobClient('k').upload(buf, len);
 *
 * Activation: `@azure/storage-blob` in package.json deps. Per-file gate:
 * any import from `@azure/storage-blob`.
 */
export const AZURE_BLOB_TS_PLUGIN_ID = 'azure-blob-ts' as const;

export class AzureBlobTsPlugin implements FrameworkPlugin {
  readonly id = AZURE_BLOB_TS_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return '@azure/storage-blob' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createAzureBlobTsVisitor();
}
