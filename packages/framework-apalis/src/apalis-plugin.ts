import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createApalisVisitor } from './visitor.js';

/**
 * apalis framework plugin — modern Rust task queue.
 *
 * Closes the Rust task-queue gap. Mirrors framework-celery / asynq /
 * bullmq: producers and consumers share `httpMethod: 'JOB'` and a
 * matching `apalis:<job-type>` urlLiteral/routePattern so the
 * flow-stitcher joins them.
 *
 * Detected shapes:
 *
 *   // Producer
 *   storage.push(SendEmailJob { to: "x".into() }).await?
 *
 *   // Consumer
 *   WorkerBuilder::new("send-email")
 *       .with_storage(storage.clone())
 *       .build_fn(send_email)
 *
 *   async fn send_email(job: SendEmailJob) -> Result<(), Error> { ... }
 *
 * The job TYPE (a struct) is the de-facto routing key in apalis.
 * The visitor emits both sides using the struct's last-segment
 * identifier so the stitcher can connect them by exact match.
 *
 * Activation: `apalis` or `apalis-core` crate in Cargo.toml.
 */
export const APALIS_PLUGIN_ID = 'apalis' as const;

export class ApalisPlugin implements FrameworkPlugin {
  readonly id = APALIS_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'apalis') || hasCargoCrate(ctx, 'apalis-core');
  }

  readonly visitor: RustFrameworkVisitor = createApalisVisitor();
}
