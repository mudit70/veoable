import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createGosqlxVisitor } from './visitor.js';

/**
 * jmoiron/sqlx framework plugin — Go's dominant SQL query layer.
 *
 * sqlx is a thin wrapper over `database/sql` providing typed scans
 * (`Get`/`Select` populate structs) plus named-query helpers. Table
 * names live in SQL-string args at call sites, exactly like
 * framework-sqlx (Rust) / framework-knex (TS).
 *
 * We synthesize DatabaseTable nodes from observed table names in
 * the parsed SQL — same approach the other SQL-string plugins use.
 *
 * Activation: any `github.com/jmoiron/sqlx` entry in any go.mod
 * under the project tree.
 */
export const GOSQLX_PLUGIN_ID = 'gosqlx' as const;

export class GosqlxPlugin implements FrameworkPlugin {
  readonly id = GOSQLX_PLUGIN_ID;
  readonly language = 'go';

  private _visitor: GoFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    return hasGoModule(ctx, 'github.com/jmoiron/sqlx');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'sqlx' }),
      // sqlx is dialect-agnostic — same canonical `postgres` kind
      // the Rust sqlx plugin uses. A future slice could read the
      // import comments / driver hints to pick precisely.
      kind: 'postgres',
      name: 'sqlx',
      connectionSource: 'go-modules',
    };
    this._visitor = createGosqlxVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): GoFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'sqlx' });
      this._visitor = createGosqlxVisitor(systemId);
    }
    return this._visitor;
  }
}
