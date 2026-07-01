import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createKafkarsVisitor } from './visitor.js';

/**
 * Kafka (Rust) framework plugin.
 *
 * Covers the rdkafka crate (rust-rdkafka). Third slice of the
 * cross-language Kafka trifecta — kafkapy + kafkago already merged.
 *
 * Detected call shapes:
 *
 *   producer.send(
 *       FutureRecord::to("user-events").payload("data").key("k"),
 *       Timeout::Never,
 *   ).await?;
 *
 *   let producer: BaseProducer = ...;
 *   producer.send(BaseRecord::to("orders").payload("p").key("k"))?;
 *
 *   consumer.subscribe(&["user-events", "orders"])?;
 *
 * Emit shape (mirrors kafkapy / kafkago):
 *   Producer (FutureRecord::to / BaseRecord::to literal) →
 *     ClientSideAPICaller, urlLiteral = `kafka:<topic>`, JOB
 *   Consumer (.subscribe(&["..."])) →
 *     APIEndpoint,         routePattern = `kafka:<topic>`, JOB
 *
 * Activation: `rdkafka` crate in Cargo.toml.
 */
export const KAFKARS_PLUGIN_ID = 'kafkars' as const;

export class KafkarsPlugin implements FrameworkPlugin {
  readonly id = KAFKARS_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'rdkafka');
  }

  readonly visitor: RustFrameworkVisitor = createKafkarsVisitor();
}
