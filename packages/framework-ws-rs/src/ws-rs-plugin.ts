import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createWsRsVisitor } from './visitor.js';

/**
 * WebSockets (Rust) framework plugin.
 *
 * Covers tokio-tungstenite + tungstenite (the de facto Rust WS
 * ecosystem). Mirrors the ws-ts / ws-py / ws-go emit shape so the
 * flow stitcher pairs server↔client by exact URL match.
 *
 * Detected call shapes:
 *
 *   let ws_stream = accept_async(stream).await?;
 *   let (mut ws, _) = connect_async("ws://api/feed").await?;
 *
 * Activation: `tokio-tungstenite` or `tungstenite` crate in
 * Cargo.toml. Per-file gate: `use tokio_tungstenite` or
 * `use tungstenite`.
 */
export const WS_RS_PLUGIN_ID = 'ws-rs' as const;

export class WsRsPlugin implements FrameworkPlugin {
  readonly id = WS_RS_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return (
      hasCargoCrate(ctx, 'tokio-tungstenite')
      || hasCargoCrate(ctx, 'tungstenite')
    );
  }

  readonly visitor: RustFrameworkVisitor = createWsRsVisitor();
}
