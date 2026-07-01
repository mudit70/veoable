import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createBoto3Visitor } from './visitor.js';

/**
 * boto3 framework plugin — Python's AWS SDK.
 *
 * Closes the cloud-SDK / object-storage gap. Models S3 operations as
 * ClientSideAPICaller with `urlLiteral: 's3://<bucket>/<key>'` and
 * `httpMethod` derived from the operation kind:
 *
 *   GET    s3.get_object, list_objects, head_object, get_*
 *   POST   s3.create_multipart_upload (and similar create_* calls)
 *   PUT    s3.put_object, copy_object, upload_file, upload_fileobj,
 *          upload_part
 *   DELETE s3.delete_object(s), delete_bucket, abort_multipart_upload
 *
 * The flow-stitcher can use the s3:// URL to connect callers across
 * the project that touch the same bucket+key.
 *
 * Activation: `boto3` or `aioboto3` in any Python manifest.
 */
export const BOTO3_PLUGIN_ID = 'boto3-s3' as const;

export class Boto3Plugin implements FrameworkPlugin {
  readonly id = BOTO3_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'boto3') || hasPythonPackage(ctx, 'aioboto3');
  }

  readonly visitor: PyFrameworkVisitor = createBoto3Visitor();
}
