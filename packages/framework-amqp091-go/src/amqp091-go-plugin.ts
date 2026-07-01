import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { createAmqp091GoVisitor } from './visitor.js';

/**
 * amqp091-go RabbitMQ client framework plugin (Phase 5k of #474).
 *
 * Producer:
 *   channel.PublishWithContext(ctx, "exchange", "routing.key",
 *                              mandatory, immediate, amqp.Publishing{...})
 *   channel.Publish("exchange", "routing.key", false, false, amqp.Publishing{...})
 *
 * Consumer:
 *   channel.Consume("queue", "consumer-tag", autoAck, exclusive,
 *                   noLocal, noWait, args)
 *
 * Activation: rabbitmq/amqp091-go in go.mod (and the legacy
 * streadway/amqp path).
 */
export const AMQP091_GO_PLUGIN_ID = 'amqp091-go' as const;

export class Amqp091GoPlugin implements FrameworkPlugin {
  readonly id = AMQP091_GO_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    return (
      hasGoModule(ctx, 'github.com/rabbitmq/amqp091-go')
      || hasGoModule(ctx, 'github.com/streadway/amqp')
    );
  }

  readonly visitor: GoFrameworkVisitor = createAmqp091GoVisitor();
}
