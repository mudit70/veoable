import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createReqwestVisitor } from './visitor.js';

/**
 * reqwest framework plugin — Rust HTTP client (outbound calls).
 *
 * Emits one `ClientSideAPICaller` per recognized outbound HTTP call
 * site. Mirrors the TS-side axios/fetch plugins: the URL string and
 * HTTP verb are recovered statically; dynamic URL shapes (format!,
 * concat!, identifier-bound strings, `.to_string()` chains) emit with
 * `urlLiteral: null` + `egressConfidence: 'dynamic'`.
 *
 * Detected shapes:
 *
 *   // Top-level convenience
 *   reqwest::get("https://api.example.com/users").await?
 *   reqwest::blocking::get("https://api.example.com/users")?
 *
 *   // Client method chain — the bread-and-butter form
 *   client.get("https://api.example.com/users").send().await?;
 *   client.post("https://api.example.com/users").json(&body).send().await?;
 *   client.put(format!("https://api.example.com/users/{id}")).send().await?;
 *   client.delete(url).send().await?;
 *
 *   // ClientBuilder result — same receiver heuristic
 *   let api = reqwest::ClientBuilder::new().build()?;
 *   api.patch("https://api.example.com/u").send().await?;
 *
 * Activation: any `reqwest` entry in any Cargo.toml under the project.
 */
export const REQWEST_PLUGIN_ID = 'reqwest' as const;

export class ReqwestPlugin implements FrameworkPlugin {
  readonly id = REQWEST_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'reqwest');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    this._visitor = createReqwestVisitor();
    return { nodes: [], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) this._visitor = createReqwestVisitor();
    return this._visitor;
  }
}
