import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createSequelizeVisitor } from './visitor.js';

/**
 * Sequelize framework plugin (#367).
 *
 * Detects two forms of Sequelize models:
 *   1. sequelize-typescript classes decorated with @Table({ tableName }).
 *   2. Vanilla `class User extends Model { ... }` with `Model.init({...})`
 *      called from a setup function.
 *
 * Receiver detection — Sequelize's idiom is STATIC methods on the
 * model class itself:
 *
 *   await User.findOne({ where: { id } });
 *   await User.create({ email });
 *   await User.update({ name }, { where: { id } });
 *   await User.destroy({ where: { id } });
 *
 * Plus instance methods (`user.update(...)`, `user.destroy(...)`).
 * The visitor collects the set of Model subclass names during entity
 * discovery and looks up receivers in that set.
 */
export const SEQUELIZE_PLUGIN_ID = 'sequelize' as const;

export class SequelizePlugin implements FrameworkPlugin {
  readonly id = SEQUELIZE_PLUGIN_ID;
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
      if ('sequelize' in deps || 'sequelize-typescript' in deps) return true;
    }
    return false;
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'sequelize' }),
      kind: 'postgres',
      name: 'sequelize',
      connectionSource: 'sequelize-config',
    };
    this._visitor = createSequelizeVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'sequelize' });
      this._visitor = createSequelizeVisitor(systemId);
    }
    return this._visitor;
  }
}
