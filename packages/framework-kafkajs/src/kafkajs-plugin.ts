import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createKafkajsVisitor } from './visitor.js';

/**
 * kafkajs framework plugin — Kafka producer/consumer in TypeScript.
 *
 * Completes the cross-language Kafka trifecta-into-quadfecta
 * (kafkapy / kafkago / kafkars all merged). Mirrors their emit
 * shape exactly so the flow stitcher pairs producers↔consumers by
 * `urlLiteral === routePattern === kafka:<topic>`.
 *
 * Detected shapes:
 *
 *   // Producer
 *   await producer.send({ topic: 'user-events', messages: [{ value: 'x' }] });
 *   await producer.sendBatch({ topicMessages: [{ topic: 'X', messages: [...] }] });
 *
 *   // Consumer
 *   await consumer.subscribe({ topic: 'user-events' });
 *   await consumer.subscribe({ topics: ['user-events', 'orders'] });
 *
 * Activation: `kafkajs` in package.json dependencies or
 * devDependencies. Per-file gate: any `import ... from 'kafkajs'`.
 */
export const KAFKAJS_PLUGIN_ID = 'kafkajs' as const;

export class KafkajsPlugin implements FrameworkPlugin {
  readonly id = KAFKAJS_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'kafkajs' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createKafkajsVisitor();
}
