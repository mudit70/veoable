import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createElasticRsVisitor } from './visitor.js';

/**
 * Elasticsearch (Rust) framework plugin.
 *
 * Mirrors elastic-ts/py/go. Covers the `elasticsearch` crate (the
 * official Elasticsearch Rust client).
 *
 * Detected call shapes (builder-with-Parts pattern):
 *
 *   client.index(IndexParts::Index("users")).body(json!({...})).send().await?;
 *   client.search(SearchParts::Index(&["users"])).body(json!({...})).send().await?;
 *   client.get(GetParts::IndexId("users", "1")).send().await?;
 *   client.update(UpdateParts::IndexId("users", "1")).body(json!(...)).send().await?;
 *   client.delete(DeleteParts::IndexId("users", "1")).send().await?;
 *
 * The index name is the first string-literal arg to the
 * `<Verb>Parts::*` enum constructor.
 *
 * Activation: `elasticsearch` crate in Cargo.toml. Per-file gate:
 * `use elasticsearch`.
 */
export const ELASTIC_RS_PLUGIN_ID = 'elastic-rs' as const;

export class ElasticRsPlugin implements FrameworkPlugin {
  readonly id = ELASTIC_RS_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'elasticsearch');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-rs' }),
      kind: 'elasticsearch',
      name: 'elastic-rs',
      connectionSource: 'cargo-crate',
    };
    this._visitor = createElasticRsVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-rs' });
      this._visitor = createElasticRsVisitor(systemId);
    }
    return this._visitor;
  }
}
