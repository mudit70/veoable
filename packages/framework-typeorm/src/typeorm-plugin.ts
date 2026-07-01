import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createTypeormVisitor } from './visitor.js';

export const TYPEORM_PLUGIN_ID = 'typeorm' as const;

export class TypeormPlugin implements FrameworkPlugin {
  readonly id = TYPEORM_PLUGIN_ID;
  readonly language = 'ts';

  private _visitor: TsFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'typeorm' in deps || '@nestjs/typeorm' in deps;
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'typeorm' }),
      kind: 'postgres',
      name: 'typeorm',
      connectionSource: 'ormconfig',
    };
    this._visitor = createTypeormVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'typeorm' });
      this._visitor = createTypeormVisitor(systemId);
    }
    return this._visitor;
  }
}
