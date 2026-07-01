import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createMcpServerRustVisitor } from './visitor.js';

/**
 * Rust MCP server framework plugin (#537).
 *
 * Mirrors `framework-mcp-server` (TS, #437) for Rust. The Rust MCP
 * SDKs in the wild today (rmcp / mcp-rs / mcp-rust-sdk / mcp_sdk)
 * share the same load-bearing surface: tools are registered as
 * `#[tool(...)]`-attributed methods inside an `impl` block, with the
 * tool name defaulting to the method name unless overridden by a
 * `name = "..."` attribute argument.
 *
 *     #[tool(description = "Increment the counter")]
 *     fn increment(&self) -> Result<CallToolResult, McpError> { … }
 *
 *     #[tool(name = "decrement_v2", description = "Decrement v2")]
 *     fn decrement(&self) -> Result<CallToolResult, McpError> { … }
 *
 * Each emits as an `APIEndpoint` with `httpMethod: 'TOOL'` and
 * `routePattern: 'mcp:<tool-name>'`. The TS plugin uses
 * `framework: 'mcp-server'`; this one uses `framework:
 * 'mcp-server-rust'` so per-repo coverage stays distinguishable
 * across languages (parallels the grpcio / grpcgo / tonic split).
 *
 * Detection signal: any of the known Rust MCP SDK crates in
 * `Cargo.toml`. False-positive surface is bounded by the project-
 * level gate (the SDK must be in dependencies). A repo that
 * happens to define `#[tool]` for a non-MCP purpose won't activate
 * unless it also depends on one of the recognized crates.
 *
 * Out of scope (deferred follow-ups):
 *   - Builder-style `Server::new().tool("name", handler)` registration.
 *     Less common in the SDK shapes that landed in 2025-2026; can
 *     be added once we have an OSS fixture exercising it.
 *   - Resource / prompt registrations. Same shape pattern as `#[tool]`
 *     but with `#[resource]` / `#[prompt]` attributes; trivially
 *     extendable once we see them in the wild.
 */
export const MCP_SERVER_RUST_PLUGIN_ID = 'mcp-server-rust' as const;

const MCP_RUST_CRATES = [
  'rmcp',
  'mcp-rust-sdk',
  'mcp-rs',
  'mcp_sdk',
  'modelcontextprotocol-sdk',
];

export class MCPServerRustPlugin implements FrameworkPlugin {
  readonly id = MCP_SERVER_RUST_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return MCP_RUST_CRATES.some((c) => hasCargoCrate(ctx, c));
  }

  readonly visitor: RustFrameworkVisitor = createMcpServerRustVisitor();
}
