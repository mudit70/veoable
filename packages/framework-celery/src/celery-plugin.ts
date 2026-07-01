import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasPythonPackage } from '@adorable/plugin-api';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { createCeleryVisitor } from './visitor.js';

/**
 * Celery framework plugin — Python's dominant task-queue library.
 *
 * Mirrors framework-bullmq on the TS side: producer / consumer pairs
 * are modeled as ClientSideAPICaller / APIEndpoint with
 * `httpMethod: 'JOB'` so the existing flow-stitcher connects them by
 * matching `urlLiteral === routePattern`.
 *
 * Detected shapes:
 *
 *   # Task definition (consumer side) — APIEndpoint
 *   @app.task
 *   def process_upload(payload):
 *       ...
 *
 *   @app.task(name='upload.process')
 *   def explicit_name(payload):
 *       ...
 *
 *   @shared_task
 *   def maintenance(): ...
 *
 *   # Task invocation (producer side) — ClientSideAPICaller
 *   process_upload.delay(payload)
 *   process_upload.apply_async(args=[payload])
 *   app.send_task('upload.process', args=[...])
 *
 * Activation: any `celery` entry in a Python manifest.
 */
export const CELERY_PLUGIN_ID = 'celery' as const;

export class CeleryPlugin implements FrameworkPlugin {
  readonly id = CELERY_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'celery');
  }

  readonly visitor: PyFrameworkVisitor = createCeleryVisitor();
}
