import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createSqlxVisitor } from './visitor.js';

/**
 * sqlx framework plugin (#439 first slice).
 *
 * sqlx is the most widely-used Rust query layer today. Table names
 * exist only as SQL-string arguments at call sites:
 *
 *   sqlx::query!("SELECT * FROM users WHERE id = $1", id).fetch_one(&pool)
 *   sqlx::query_as!(User, "SELECT * FROM users").fetch_all(&pool)
 *   sqlx::query("INSERT INTO orders ...").execute(&pool)
 *   conn.execute("DELETE FROM users WHERE id = $1")
 *
 * Like knex on the TS side, we synthesize DatabaseTable nodes from
 * the set of observed table-name string literals. Column extraction
 * would require parsing migrations (`sqlx-cli` migration files);
 * deferred to a follow-up slice.
 *
 * Activation: detect `sqlx` in any Cargo.toml under the project tree.
 * The crate is sometimes pulled in transitively via `sqlx-core` /
 * `sqlx-macros`; we only check the top-level facade since those
 * sub-crates aren't directly used by application code.
 */
export const SQLX_PLUGIN_ID = 'sqlx' as const;

export class SqlxPlugin implements FrameworkPlugin {
  readonly id = SQLX_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'sqlx');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'sqlx' }),
      // sqlx supports Postgres/MySQL/SQLite/MSSQL via feature flags.
      // Picking `postgres` as the canonical kind matches the knex
      // convention (knex is similarly multi-dialect). A future slice
      // can read the `runtime-*` / `postgres` / `mysql` feature flags
      // out of Cargo.toml to pick the right kind precisely.
      kind: 'postgres',
      name: 'sqlx',
      connectionSource: 'cargo-features',
    };
    this._visitor = createSqlxVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'sqlx' });
      this._visitor = createSqlxVisitor(systemId);
    }
    return this._visitor;
  }
}
