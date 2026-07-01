import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createWsTsVisitor } from './visitor.js';

/**
 * WebSocket (TypeScript / Node) framework plugin.
 *
 * Covers the two dominant Node WS libraries:
 *
 *   ws (HQ standard):
 *     const wss = new WebSocketServer({ port: 8080, path: '/api/chat' });
 *     wss.on('connection', (socket) => { ... });
 *     const client = new WebSocket('ws://api.example.com/feed');
 *
 *   socket.io:
 *     const io = new Server(httpServer);
 *     io.on('connection', (socket) => {
 *       socket.on('chat:message', handler);
 *     });
 *
 * Emit shape:
 *   Server side → APIEndpoint, `httpMethod='WS'`,
 *                 `routePattern='ws:<path>'` (or `'ws:/'` when no path).
 *   Client side → ClientSideAPICaller, `httpMethod='WS'`,
 *                 `urlLiteral=<ws-url>`.
 *
 * Per-file activation gate: any import from `'ws'` or `'socket.io'`.
 * Project gate: same packages in package.json deps.
 */
export const WS_TS_PLUGIN_ID = 'ws-ts' as const;

export class WsTsPlugin implements FrameworkPlugin {
  readonly id = WS_TS_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'ws' in deps || 'socket.io' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createWsTsVisitor();
}
