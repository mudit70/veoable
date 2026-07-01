import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createAzureBlobPyVisitor } from './visitor.js';

/**
 * Azure Blob framework plugin — Python `azure-storage-blob`.
 *
 * Second slice of the Azure Blob quadfecta (after framework-azure-blob-ts).
 * Mirrors the AWS S3 / GCS quadfecta emit shape — caller-only, azure://
 * URLs, isExternal=true + externalHost=`<container>.blob.core.windows.net`.
 *
 * Detection is fluent-chain based:
 *
 *   from azure.storage.blob import BlobServiceClient
 *   svc = BlobServiceClient.from_connection_string(conn_str)
 *   svc.get_container_client("c").get_blob_client("k").download_blob()
 *   svc.get_container_client("c").get_blob_client("k").upload_blob(data)
 *   svc.get_container_client("c").get_blob_client("k").delete_blob()
 *   svc.get_container_client("c").list_blobs()
 *   svc.get_container_client("c").delete_container()
 *
 * Activation: `azure-storage-blob` in any Python manifest.
 */
export const AZURE_BLOB_PY_PLUGIN_ID = 'azure-blob-py' as const;

export class AzureBlobPyPlugin implements FrameworkPlugin {
  readonly id = AZURE_BLOB_PY_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'azure-storage-blob');
  }

  readonly visitor: PyFrameworkVisitor = createAzureBlobPyVisitor();
}
