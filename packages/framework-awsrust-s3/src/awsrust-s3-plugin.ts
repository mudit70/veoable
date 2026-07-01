import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createAwsrustS3Visitor } from './visitor.js';
import { buildStructFieldMap, type StructFieldMap } from './struct-field-resolver.js';

/**
 * aws-sdk-* (Rust) framework plugin.
 *
 * Originally S3-only — extended (Phase 5u) to cover DynamoDB, SQS, SNS,
 * and Lambda in the same plugin. Each service gets its own URL scheme,
 * framework label, and externalHost:
 *
 *   s3://<bucket>/<key>      framework=awsrust-s3
 *   dynamodb://<table>/      framework=awsrust-dynamodb
 *   sqs:<queue-name>         framework=awsrust-sqs        (JOB)
 *   sns:<topic-name>         framework=awsrust-sns        (JOB)
 *   lambda:<function-name>   framework=awsrust-lambda     (POST)
 *
 * Detected call shape (the SDK's builder pattern):
 *
 *   client.put_object()
 *       .bucket("my-bucket")
 *       .key("path/to/file")
 *       .body(body.into())
 *       .send()
 *       .await?
 *
 * Activation: any of the AWS SDK Rust service crates.
 */
export const AWSRUST_S3_PLUGIN_ID = 'awsrust-s3' as const;

const AWS_RUST_CRATES = [
  'aws-sdk-s3',
  'aws-sdk-dynamodb',
  'aws-sdk-sqs',
  'aws-sdk-sns',
  'aws-sdk-lambda',
];

export class AwsrustS3Plugin implements FrameworkPlugin {
  readonly id = AWSRUST_S3_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;
  private _structMap: StructFieldMap | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return AWS_RUST_CRATES.some((c) => hasCargoCrate(ctx, c));
  }

  /**
   * Project-load pass: scans every `.rs` file for struct-field
   * default literals so the visitor can resolve identifier args like
   * `.table_name(&state.orders_table)` against `AppState`'s known
   * field defaults (#523 item 1).
   */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    this._structMap = buildStructFieldMap(ctx.rootDir);
    this._visitor = createAwsrustS3Visitor(this._structMap);
    return { nodes: [], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      this._visitor = createAwsrustS3Visitor(this._structMap ?? undefined);
    }
    return this._visitor;
  }
}
