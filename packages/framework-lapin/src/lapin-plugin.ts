import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createLapinVisitor } from './visitor.js';

/**
 * RabbitMQ (Rust) framework plugin — `lapin` crate.
 *
 * Fourth slice of the RabbitMQ quadfecta (amqplib TS, pika Python,
 * amqp091-go Go already merged).
 *
 * Detected call shapes:
 *
 *   channel.basic_publish("exchange", "routing.key", options, payload, props).await?;
 *   channel.basic_consume("queue", "consumer-tag", options, args).await?;
 *
 * Emit shape (mirrors amqp091-go / amqplib / pika):
 *   Producer (`basic_publish` with literal exchange + routing_key) →
 *     ClientSideAPICaller, urlLiteral = `amqp:<exchange>/<routingKey>`, JOB
 *   Consumer (`basic_consume` with literal queue) →
 *     APIEndpoint,         routePattern = `amqp:/<queue>`, JOB
 *
 * Activation: `lapin` crate in Cargo.toml.
 */
export const LAPIN_PLUGIN_ID = 'lapin' as const;

export class LapinPlugin implements FrameworkPlugin {
  readonly id = LAPIN_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'lapin');
  }

  readonly visitor: RustFrameworkVisitor = createLapinVisitor();
}
