import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createGcsPyVisitor } from './visitor.js';

/**
 * GCS framework plugin — Python `google-cloud-storage` SDK.
 *
 * Second slice of the GCS quadfecta (after framework-gcs-ts). Mirrors
 * the AWS S3 / GCS-TS emit shape — caller-only, gs:// URLs,
 * isExternal=true + externalHost=`<bucket>.storage.googleapis.com`.
 *
 * Detection is fluent-chain based:
 *
 *   from google.cloud import storage
 *   client = storage.Client()
 *   client.bucket("b").blob("k").download_as_text()    # GET gs://b/k
 *   client.bucket("b").blob("k").upload_from_string(s) # PUT gs://b/k
 *   client.bucket("b").list_blobs()                    # GET gs://b/
 *   client.bucket("b").delete()                        # DELETE gs://b/
 *
 * Activation: `google-cloud-storage` in any Python manifest.
 */
export const GCS_PY_PLUGIN_ID = 'gcs-py' as const;

export class GcsPyPlugin implements FrameworkPlugin {
  readonly id = GCS_PY_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'google-cloud-storage');
  }

  readonly visitor: PyFrameworkVisitor = createGcsPyVisitor();
}
