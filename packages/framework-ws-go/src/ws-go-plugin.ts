import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createWsGoVisitor } from './visitor.js';

/**
 * WebSockets (Go) framework plugin.
 *
 * Covers both gorilla/websocket and nhooyr.io/websocket:
 *
 *   gorilla/websocket:
 *     conn, err := upgrader.Upgrade(w, r, nil)
 *     c, _, err := websocket.DefaultDialer.Dial("ws://...", nil)
 *
 *   nhooyr.io/websocket:
 *     c, err := websocket.Accept(w, r, nil)
 *     c, _, err := websocket.Dial(ctx, "ws://...", nil)
 *
 * Emit shape (mirrors framework-ws-ts / framework-ws-py):
 *   Server side (Upgrade/Accept call) → APIEndpoint,
 *                                       routePattern='ws:/'.
 *   Client side (Dial call)           → ClientSideAPICaller,
 *                                       urlLiteral=<ws-url>.
 *
 * Activation: either module in go.mod.
 */
export const WS_GO_PLUGIN_ID = 'ws-go' as const;

export class WsGoPlugin implements FrameworkPlugin {
  readonly id = WS_GO_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    return (
      hasGoModule(ctx, 'github.com/gorilla/websocket')
      || hasGoModule(ctx, 'nhooyr.io/websocket')
      || hasGoModule(ctx, 'github.com/coder/websocket')
    );
  }

  readonly visitor: GoFrameworkVisitor = createWsGoVisitor();
}
