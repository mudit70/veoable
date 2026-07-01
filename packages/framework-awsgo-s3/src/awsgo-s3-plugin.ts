import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { createAwsgoS3Visitor } from './visitor.js';

/**
 * aws-sdk-go-v2 framework plugin.
 *
 * Originally S3-only — extended to cover DynamoDB, SQS, SNS, and
 * Lambda in the same plugin (Phase 5u). Each service gets its own
 * URL scheme, framework label, and externalHost so the flow stitcher
 * distinguishes between them:
 *
 *   s3://<bucket>/<key>      framework=awsgo-s3
 *   dynamodb://<TableName>/  framework=awsgo-dynamodb
 *   sqs:<queue-name>         framework=awsgo-sqs        (JOB)
 *   sns:<topic-name>         framework=awsgo-sns        (JOB)
 *   lambda:<FunctionName>    framework=awsgo-lambda     (POST)
 *
 * Detected call shape (positional + Input-struct):
 *   client.Verb(ctx, &<svc>.<Verb>Input{ Field: aws.String("..."), .. })
 *
 * Activation: any of the AWS SDK Go service modules below.
 */
export const AWSGO_S3_PLUGIN_ID = 'awsgo-s3' as const;

const AWS_SDK_GO_MODULES = [
  'github.com/aws/aws-sdk-go-v2/service/s3',
  'github.com/aws/aws-sdk-go-v2/service/dynamodb',
  'github.com/aws/aws-sdk-go-v2/service/sqs',
  'github.com/aws/aws-sdk-go-v2/service/sns',
  'github.com/aws/aws-sdk-go-v2/service/lambda',
  // v1 fallbacks
  'github.com/aws/aws-sdk-go/service/s3',
  'github.com/aws/aws-sdk-go/service/dynamodb',
  'github.com/aws/aws-sdk-go/service/sqs',
  'github.com/aws/aws-sdk-go/service/sns',
  'github.com/aws/aws-sdk-go/service/lambda',
];

export class AwsgoS3Plugin implements FrameworkPlugin {
  readonly id = AWSGO_S3_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    return AWS_SDK_GO_MODULES.some((m) => hasGoModule(ctx, m));
  }

  readonly visitor: GoFrameworkVisitor = createAwsgoS3Visitor();
}
