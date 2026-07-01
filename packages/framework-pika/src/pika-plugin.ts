import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasPythonPackage } from '@adorable/plugin-api';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { createPikaVisitor } from './visitor.js';

/**
 * pika (Python) RabbitMQ client framework plugin.
 *
 * Mirrors amqplib emit shape.
 *
 * Producer (publish):
 *   channel.basic_publish(exchange='X', routing_key='K', body=b'...')
 *
 * Consumer:
 *   channel.basic_consume(queue='Q', on_message_callback=...)
 *
 * Activation: `pika` Python package.
 */
export const PIKA_PLUGIN_ID = 'pika' as const;

export class PikaPlugin implements FrameworkPlugin {
  readonly id = PIKA_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'pika');
  }

  readonly visitor: PyFrameworkVisitor = createPikaVisitor();
}
