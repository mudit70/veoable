import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createMongorustVisitor } from './visitor.js';

/**
 * mongodb crate framework plugin — Rust's MongoDB driver.
 *
 * Rust analog of framework-pymongo / framework-mongogo. Closes the
 * Rust NoSQL coverage gap. Models MongoDB collections as
 * DatabaseTable (kind='collection') with DatabaseSystem
 * kind='mongodb'.
 *
 * Detected shapes:
 *
 *   let client = mongodb::Client::with_uri_str(uri).await?;
 *   let db = client.database("mydb");
 *   let users = db.collection::<User>("users");
 *
 *   users.find_one(filter, None).await?
 *   users.find(filter, None).await?
 *   users.insert_one(doc, None).await?
 *   users.insert_many(docs, None).await?
 *   users.update_one(filter, update, None).await?
 *   users.update_many(filter, update, None).await?
 *   users.delete_one(filter, None).await?
 *   users.delete_many(filter, None).await?
 *   users.replace_one(filter, doc, None).await?
 *   users.aggregate(pipeline, None).await?
 *
 * Activation: `mongodb` crate in Cargo.toml.
 */
export const MONGORUST_PLUGIN_ID = 'mongorust' as const;

export class MongorustPlugin implements FrameworkPlugin {
  readonly id = MONGORUST_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'mongodb');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'mongodb', name: 'mongorust' }),
      kind: 'mongodb',
      name: 'mongorust',
      connectionSource: 'cargo-features',
    };
    this._visitor = createMongorustVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'mongodb', name: 'mongorust' });
      this._visitor = createMongorustVisitor(systemId);
    }
    return this._visitor;
  }
}
