import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createAwsS3TsVisitor } from './visitor.js';

/**
 * AWS SDK v3 (TypeScript / Node) framework plugin.
 *
 * Originally S3-only — extended (Phase 5u) to also cover DynamoDB, SQS,
 * SNS, and Lambda in the same plugin. Each service gets its own URL
 * scheme, framework label, and externalHost:
 *
 *   s3://<bucket>/<key>      framework=aws-s3-ts
 *   dynamodb://<table>/      framework=aws-dynamodb-ts
 *   sqs:<queue-name>         framework=aws-sqs-ts        (JOB)
 *   sns:<topic-name>         framework=aws-sns-ts        (JOB)
 *   lambda:<function-name>   framework=aws-lambda-ts     (POST)
 *
 * Targets the AWS SDK v3 "command" pattern:
 *
 *   import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
 *   await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
 *
 *   import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
 *   await client.send(new GetItemCommand({ TableName: 'users', Key: {...} }));
 *
 *   import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
 *   await client.send(new SendMessageCommand({ QueueUrl: '...', MessageBody: '...' }));
 *
 *   import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
 *   await client.send(new PublishCommand({ TopicArn: '...', Message: '...' }));
 *
 *   import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
 *   await client.send(new InvokeCommand({ FunctionName: '...', Payload: ... }));
 *
 * Activation: any of the @aws-sdk/client-* packages.
 */
export const AWS_S3_TS_PLUGIN_ID = 'aws-s3-ts' as const;

const AWS_SDK_PACKAGES = [
  '@aws-sdk/client-s3',
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/client-sqs',
  '@aws-sdk/client-sns',
  '@aws-sdk/client-lambda',
];

export class AwsS3TsPlugin implements FrameworkPlugin {
  readonly id = AWS_S3_TS_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return AWS_SDK_PACKAGES.some((p) => p in deps);
  }

  readonly visitor: TsFrameworkVisitor = createAwsS3TsVisitor();
}
