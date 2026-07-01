import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasPythonPackage } from '@adorable/plugin-api';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { createWsPyVisitor } from './visitor.js';

/**
 * WebSockets (Python) framework plugin.
 *
 * Covers the `websockets` library (Aaugustin's HQ standard):
 *
 *   async with websockets.serve(handler, "localhost", 8765):
 *       await asyncio.Future()
 *
 *   async with websockets.connect("ws://api/feed") as ws:
 *       await ws.send(...)
 *
 * Emit shape (mirrors framework-ws-ts):
 *   Server side → APIEndpoint, `httpMethod='WS'`,
 *                 `routePattern='ws:/'`. The websockets.serve API
 *                 takes a handler + host + port + (no path); we use
 *                 `'ws:/'` as the default route.
 *   Client side → ClientSideAPICaller, `httpMethod='WS'`,
 *                 `urlLiteral=<ws-url>`.
 *
 * Activation: `websockets` Python package.
 */
export const WS_PY_PLUGIN_ID = 'ws-py' as const;

export class WsPyPlugin implements FrameworkPlugin {
  readonly id = WS_PY_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'websockets');
  }

  readonly visitor: PyFrameworkVisitor = createWsPyVisitor();
}
