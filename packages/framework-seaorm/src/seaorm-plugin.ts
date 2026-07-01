import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createSeaormVisitor } from './visitor.js';
import { scanProjectForTableNames } from './scan-project.js';

/**
 * SeaORM framework plugin — modern Rust ORM.
 *
 * Detects entity-scoped DB operations like:
 *   User::find().all(db).await?
 *   User::find_by_id(1).one(db).await?
 *   User::insert(active_model).exec(db).await?
 *   User::delete_by_id(1).exec(db).await?
 *
 * Table names come from:
 *   1. `#[sea_orm(table_name = "X")]` attributes on Entity structs
 *      (scanned per file)
 *   2. Otherwise, lowercased entity identifier as a fallback heuristic.
 *
 * Activation: `sea-orm` or `sea-orm-cli` in any Cargo.toml under the
 * project tree.
 */
export const SEAORM_PLUGIN_ID = 'seaorm' as const;

export class SeaormPlugin implements FrameworkPlugin {
  readonly id = SEAORM_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'sea-orm') || hasCargoCrate(ctx, 'sea-orm-cli');
  }

  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'seaorm' }),
      kind: 'postgres',
      name: 'seaorm',
      connectionSource: 'cargo-features',
    };
    // Pre-scan ALL .rs files for entity → table_name mappings so the
    // visitor resolves correctly even when the entity declarations
    // and call sites live in different files (the canonical SeaORM
    // layout: `src/entities/*.rs` + `src/handlers/*.rs`).
    const projectTableMap = scanProjectForTableNames(ctx.rootDir, ctx.files);
    this._visitor = createSeaormVisitor(system.id, projectTableMap);
    return { nodes: [system], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'seaorm' });
      this._visitor = createSeaormVisitor(systemId, new Map());
    }
    return this._visitor;
  }
}
