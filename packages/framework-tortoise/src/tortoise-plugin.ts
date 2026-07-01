import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createTortoiseVisitor } from './visitor.js';

/**
 * tortoise-orm (Python async ORM) framework plugin.
 *
 * Detected shapes:
 *   await User.create(name='alice')                   — insert
 *   await User.filter(name='alice').all()              — read
 *   await User.get(id=1) / .get_or_none(...)           — read
 *   await User.exists()                                — read
 *   await User.update_or_create(...)                   — insert
 *   await User.bulk_create([...])                      — insert
 *   await User.filter(...).update(age=31)              — update
 *   await User.filter(...).delete()                    — delete
 *
 * Activation: `tortoise-orm` Python package.
 */
export const TORTOISE_PLUGIN_ID = 'tortoise' as const;

export class TortoisePlugin implements FrameworkPlugin {
  readonly id = TORTOISE_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'tortoise-orm');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'other', name: 'tortoise' }),
      kind: 'other',
      name: 'tortoise',
      connectionSource: 'python-package',
    };
    this._visitor = createTortoiseVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'other', name: 'tortoise' });
      this._visitor = createTortoiseVisitor(systemId);
    }
    return this._visitor;
  }
}
