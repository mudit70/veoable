import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createDrizzleVisitor } from './visitor.js';

/**
 * Drizzle ORM framework plugin (#365).
 *
 * Drizzle is unusual in that the schema lives in `.ts` files
 * declared with `pgTable(...)` / `mysqlTable(...)` / `sqliteTable(...)`
 * calls — there's no separate schema file format. Adorable's
 * language plugin walks every `.ts` file in the project, so the
 * visitor handles both schema discovery (tables/columns from
 * `*Table(...)` calls) and call-site detection (`<recv>.<verb>(...)`
 * fluent query builders) in a single pass.
 *
 * Receiver detection works in two modes:
 *   1. `db.select().from(usersTable)` — fluent builder. Table is
 *      identified by the `.from(<table>)` arg.
 *   2. `db.insert(usersTable).values(...)` — first-arg-is-table.
 *
 * Both modes resolve the table identifier to its `pgTable('name', ...)`
 * declaration to pick up the explicit table name. Falls back to the
 * variable name when the declaration can't be resolved.
 */

export const DRIZZLE_PLUGIN_ID = 'drizzle' as const;

export class DrizzlePlugin implements FrameworkPlugin {
  readonly id = DRIZZLE_PLUGIN_ID;
  readonly language = 'ts';

  private _visitor: TsFrameworkVisitor | null = null;
  private _systemId: string | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'drizzle-orm' in deps;
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    // Drizzle doesn't ship a separate schema file; tables are
    // discovered by the visitor as it walks `*Table(...)` calls.
    // We pre-emit one DatabaseSystem so emitted tables have
    // somewhere to anchor.
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'drizzle' }),
      kind: 'postgres',
      name: 'drizzle',
      connectionSource: 'drizzle-config',
    };
    this._systemId = system.id;
    this._visitor = createDrizzleVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      const systemId =
        this._systemId ?? idFor.databaseSystem({ kind: 'postgres', name: 'drizzle' });
      this._systemId = systemId;
      this._visitor = createDrizzleVisitor(systemId);
    }
    return this._visitor;
  }
}
