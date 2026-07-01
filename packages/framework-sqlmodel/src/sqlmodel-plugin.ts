import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createSqlmodelVisitor } from './visitor.js';

/**
 * SQLModel framework plugin (Phase 5h of #474).
 *
 * Detected shapes:
 *
 *   session.exec(select(Hero))          — read on Hero
 *   session.exec(select(Hero).where(...)) — read on Hero
 *   session.get(Hero, 1)                 — read on Hero
 *   session.add(Hero(name='alice'))      — insert on Hero
 *   session.merge(Hero(...))             — update on Hero
 *   session.delete(<instance>)           — delete on its Entity (skipped, ambiguous)
 *
 * Activation: `sqlmodel` Python package.
 */
export const SQLMODEL_PLUGIN_ID = 'sqlmodel' as const;

export class SqlmodelPlugin implements FrameworkPlugin {
  readonly id = SQLMODEL_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'sqlmodel');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'other', name: 'sqlmodel' }),
      kind: 'other',
      name: 'sqlmodel',
      connectionSource: 'python-package',
    };
    this._visitor = createSqlmodelVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'other', name: 'sqlmodel' });
      this._visitor = createSqlmodelVisitor(systemId);
    }
    return this._visitor;
  }
}
