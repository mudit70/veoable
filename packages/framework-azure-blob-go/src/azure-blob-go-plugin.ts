import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { createAzureBlobGoVisitor } from './visitor.js';

/**
 * Azure Blob framework plugin — Go `azure-sdk-for-go/sdk/storage/azblob`.
 *
 * Third slice of the Azure Blob quadfecta (TS + Python already merged).
 * Mirrors their emit shape so the flow stitcher treats all three as
 * the same external object-storage system.
 *
 * Detection is positional-arg based (NOT fluent chain) — the modern
 * azblob top-level client takes container and blob as positional args:
 *
 *   client.DownloadStream(ctx, "container", "blob", nil)
 *   client.UploadBuffer(ctx, "container", "blob", buf, nil)
 *   client.DeleteBlob(ctx, "container", "blob", nil)
 *   client.CreateContainer(ctx, "container", nil)   // container-scope
 *   client.DeleteContainer(ctx, "container", nil)   // container-scope
 *
 * Per-verb `takesBlob` flag distinguishes object ops from container
 * ops (CreateContainer / DeleteContainer skip the blob arg).
 *
 * Activation: `github.com/Azure/azure-sdk-for-go/sdk/storage/azblob`
 * in any go.mod.
 */
export const AZURE_BLOB_GO_PLUGIN_ID = 'azure-blob-go' as const;

export class AzureBlobGoPlugin implements FrameworkPlugin {
  readonly id = AZURE_BLOB_GO_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    return hasGoModule(ctx, 'github.com/Azure/azure-sdk-for-go/sdk/storage/azblob');
  }

  readonly visitor: GoFrameworkVisitor = createAzureBlobGoVisitor();
}
