import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createAsynqVisitor } from './visitor.js';

/**
 * asynq framework plugin — modern Go task queue.
 *
 * Mirrors framework-celery (Python) / framework-bullmq (TS):
 * producers and consumers share `httpMethod: 'JOB'` and a matching
 * `asynq:<task-type>` urlLiteral/routePattern, so the existing
 * flow-stitcher joins them.
 *
 * Detected shapes:
 *
 *   // Producer
 *   client := asynq.NewClient(redis.Options)
 *   task := asynq.NewTask("user:welcome", payload)
 *   client.Enqueue(task)
 *
 *   // Consumer
 *   mux := asynq.NewServeMux()
 *   mux.HandleFunc("user:welcome", handleWelcome)
 *
 * Activation: `github.com/hibiken/asynq` in any go.mod.
 */
export const ASYNQ_PLUGIN_ID = 'asynq' as const;

export class AsynqPlugin implements FrameworkPlugin {
  readonly id = ASYNQ_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    return hasGoModule(ctx, 'github.com/hibiken/asynq');
  }

  readonly visitor: GoFrameworkVisitor = createAsynqVisitor();
}
