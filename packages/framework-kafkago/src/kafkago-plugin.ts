import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createKafkagoVisitor } from './visitor.js';

/**
 * Kafka (Go) framework plugin.
 *
 * Covers the two dominant Go kafka client libraries:
 *
 *   segmentio/kafka-go:
 *     w := kafka.NewWriter(kafka.WriterConfig{Topic: "user-events", ...})
 *     w := &kafka.Writer{Topic: "user-events", ...}
 *     w.WriteMessages(ctx, kafka.Message{Topic: "events", ...})
 *     r := kafka.NewReader(kafka.ReaderConfig{Topic: "user-events", ...})
 *
 *   IBM/sarama (and the legacy Shopify/sarama path):
 *     msg := &sarama.ProducerMessage{Topic: "user-events", ...}
 *     producer.SendMessage(msg)
 *     pc, _ := consumer.ConsumePartition("user-events", 0, ...)
 *
 * Emit shape (mirrors framework-kafkapy):
 *   Producer-side composite literal → ClientSideAPICaller,
 *                                     urlLiteral = `kafka:<topic>`,
 *                                     httpMethod = 'JOB'
 *   Consumer-side literal / call    → APIEndpoint,
 *                                     routePattern = `kafka:<topic>`,
 *                                     httpMethod = 'JOB'
 *
 * The flow stitcher pairs producer.urlLiteral === consumer.routePattern
 * to render cross-service kafka topics in the canonical graph.
 *
 * Activation: any of `github.com/segmentio/kafka-go` /
 * `github.com/IBM/sarama` / `github.com/Shopify/sarama` in go.mod.
 */
export const KAFKAGO_PLUGIN_ID = 'kafkago' as const;

export class KafkagoPlugin implements FrameworkPlugin {
  readonly id = KAFKAGO_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    return (
      hasGoModule(ctx, 'github.com/segmentio/kafka-go')
      || hasGoModule(ctx, 'github.com/IBM/sarama')
      || hasGoModule(ctx, 'github.com/Shopify/sarama')
    );
  }

  readonly visitor: GoFrameworkVisitor = createKafkagoVisitor();
}
