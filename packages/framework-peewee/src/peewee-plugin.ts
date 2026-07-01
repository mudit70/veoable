import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createPeeweeVisitor } from './visitor.js';

/**
 * peewee ORM (Python) framework plugin.
 *
 * Detected shapes:
 *   User.create(name='alice')                 — insert
 *   User.select()                              — read
 *   User.get(User.id == 1)                     — read
 *   User.get_or_none(...)/get_or_create(...)   — read / insert
 *   User.update(age=31).where(...).execute()   — update
 *   User.delete().where(...).execute()         — delete
 *
 * Activation: `peewee` Python package.
 */
export const PEEWEE_PLUGIN_ID = 'peewee' as const;

export class PeeweePlugin implements FrameworkPlugin {
  readonly id = PEEWEE_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'peewee');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'other', name: 'peewee' }),
      kind: 'other',
      name: 'peewee',
      connectionSource: 'python-package',
    };
    this._visitor = createPeeweeVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'other', name: 'peewee' });
      this._visitor = createPeeweeVisitor(systemId);
    }
    return this._visitor;
  }
}
