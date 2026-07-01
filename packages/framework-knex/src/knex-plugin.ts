import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createKnexVisitor } from './visitor.js';

/**
 * Knex framework plugin (#369).
 *
 * Knex is a query builder, not an ORM — there are no static model
 * definitions. Table names exist only as STRING ARGUMENTS at call
 * sites: `knex('users').select('*')`, `db('orders').insert({...})`.
 *
 * The visitor SYNTHESIZES `DatabaseTable` nodes from the set of
 * observed table-name string literals. `DatabaseColumn` nodes are
 * not derivable from call sites — extracting columns would require
 * parsing migration files (`knex.schema.createTable(...)`), which is
 * deferred as a future enhancement.
 */
export const KNEX_PLUGIN_ID = 'knex' as const;

export class KnexPlugin implements FrameworkPlugin {
  readonly id = KNEX_PLUGIN_ID;
  readonly language = 'ts';

  private _visitor: TsFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    const sources: Array<Record<string, unknown>> = [];
    if (ctx.packageJson) sources.push(ctx.packageJson);
    for (const m of ctx.manifests ?? []) sources.push(m.packageJson);
    for (const pkg of sources) {
      const deps = {
        ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
        ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
        ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
      };
      if ('knex' in deps) return true;
    }
    return false;
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'knex' }),
      kind: 'postgres',
      name: 'knex',
      connectionSource: 'knexfile',
    };
    this._visitor = createKnexVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'knex' });
      this._visitor = createKnexVisitor(systemId);
    }
    return this._visitor;
  }
}
