import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createKafkapyVisitor } from './visitor.js';

/**
 * Kafka (Python) framework plugin.
 *
 * Covers the two dominant client libraries:
 *
 *   kafka-python:
 *     producer.send('user-events', value=b'...')
 *     KafkaConsumer('user-events', bootstrap_servers=...)
 *     consumer.subscribe(['orders'])
 *
 *   confluent-kafka:
 *     producer.produce('user-events', value=b'...')
 *     Consumer({...}).subscribe(['orders'])
 *
 * Emit shape (mirrors celery / asynq / apalis):
 *   Producer → ClientSideAPICaller, urlLiteral = `kafka:<topic>`,
 *              httpMethod = 'JOB'
 *   Consumer → APIEndpoint,         routePattern = `kafka:<topic>`,
 *              httpMethod = 'JOB'
 *
 * The flow stitcher pairs producer.urlLiteral === consumer.routePattern
 * to render cross-service kafka topics in the canonical graph.
 *
 * Activation: any of `kafka-python` / `kafka` / `confluent-kafka` /
 * `aiokafka` in a Python manifest.
 */
export const KAFKAPY_PLUGIN_ID = 'kafkapy' as const;

export class KafkapyPlugin implements FrameworkPlugin {
  readonly id = KAFKAPY_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return (
      hasPythonPackage(ctx, 'kafka-python')
      || hasPythonPackage(ctx, 'kafka')
      || hasPythonPackage(ctx, 'confluent-kafka')
      || hasPythonPackage(ctx, 'aiokafka')
    );
  }

  readonly visitor: PyFrameworkVisitor = createKafkapyVisitor();
}
