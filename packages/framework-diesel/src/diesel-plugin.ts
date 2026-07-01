import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createDieselVisitor } from './visitor.js';

/**
 * diesel framework plugin (#439 second slice).
 *
 * Diesel is the second of the two highest-priority Rust ORMs (sqlx is
 * the other). Unlike sqlx — where table names live only as SQL string
 * literals — diesel uses a typed DSL: tables are DECLARED via the
 * `diesel::table!` macro, and operations are method chains rooted at
 * `<table>::table`.
 *
 *   diesel::table! {
 *     users (id) {
 *       id    -> BigInt,
 *       email -> Text,
 *     }
 *   }
 *
 *   diesel::insert_into(users::table).values(&new_user).execute(conn)?;
 *   users::table.filter(email.eq(addr)).first::<User>(conn)?;
 *
 * That declaration means diesel is the first Rust framework where we
 * can emit accurate `DatabaseColumn` nodes (with types and primary-key
 * markers) from static analysis — sqlx's column shapes only exist in
 * migration files.
 */
export const DIESEL_PLUGIN_ID = 'diesel' as const;

export class DieselPlugin implements FrameworkPlugin {
  readonly id = DIESEL_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'diesel');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'diesel' }),
      // diesel supports Postgres/MySQL/SQLite via cargo features.
      // 'postgres' is the canonical default — matches the sqlx
      // plugin's same convention. A future slice can read the
      // active backend feature out of Cargo.toml.
      kind: 'postgres',
      name: 'diesel',
      connectionSource: 'cargo-features',
    };
    this._visitor = createDieselVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'diesel' });
      this._visitor = createDieselVisitor(systemId);
    }
    return this._visitor;
  }
}
