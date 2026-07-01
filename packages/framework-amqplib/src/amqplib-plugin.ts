import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createAmqplibVisitor } from './visitor.js';

/**
 * amqplib (TS) framework plugin — RabbitMQ client.
 *
 * Mirrors the established Kafka-style emit shape:
 *   urlLiteral === routePattern === `amqp:<exchange>/<routingKey>`
 *   httpMethod = 'JOB'
 *
 * Producer (publish):
 *   channel.publish(exchange, routingKey, content)
 *   channel.sendToQueue(queue, content)              → exchange='', routingKey=queue
 *
 * Consumer (consume):
 *   channel.consume(queue, handler)                  → exchange='', routingKey=queue
 *
 * Activation: `amqplib` in package.json. Per-file gate: import from
 * `'amqplib'` or `'amqplib/callback_api'`.
 */
export const AMQPLIB_PLUGIN_ID = 'amqplib' as const;

export class AmqplibPlugin implements FrameworkPlugin {
  readonly id = AMQPLIB_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'amqplib' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createAmqplibVisitor();
}
