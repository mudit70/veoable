import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasPythonPackage } from '@adorable/plugin-api';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createSqlalchemyVisitor } from './visitor.js';

export const SQLALCHEMY_PLUGIN_ID = 'sqlalchemy' as const;

export class SqlalchemyPlugin implements FrameworkPlugin {
  readonly id = SQLALCHEMY_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'sqlalchemy');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'other', name: 'sqlalchemy' }),
      kind: 'other',
      name: 'sqlalchemy',
      connectionSource: 'env("DATABASE_URL")',
    };
    this._visitor = createSqlalchemyVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'other', name: 'sqlalchemy' });
      this._visitor = createSqlalchemyVisitor(systemId);
    }
    return this._visitor;
  }
}
