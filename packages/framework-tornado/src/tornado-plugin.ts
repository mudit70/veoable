import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasPythonPackage } from '@adorable/plugin-api';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { createTornadoVisitor } from './visitor.js';

/**
 * Tornado framework plugin — Python's classic async web framework.
 *
 * Detected pattern:
 *
 *   class UserHandler(tornado.web.RequestHandler):
 *       async def get(self): ...
 *       async def post(self): ...
 *
 *   app = tornado.web.Application([
 *       (r'/users', UserHandler),
 *       (r'/users/(\d+)', UserDetailHandler),
 *   ])
 *
 * Per-method emit: one APIEndpoint per HTTP-verb method on a class
 * that inherits from `tornado.web.RequestHandler` (or `RequestHandler`
 * if imported bare). Routes resolve via a per-file pre-scan of
 * `tornado.web.Application([(URL, Handler), ...])` calls — the
 * canonical Tornado registration pattern.
 *
 * Activation: any `tornado` entry in a Python manifest.
 */
export const TORNADO_PLUGIN_ID = 'tornado' as const;

export class TornadoPlugin implements FrameworkPlugin {
  readonly id = TORNADO_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'tornado');
  }

  readonly visitor: PyFrameworkVisitor = createTornadoVisitor();
}
