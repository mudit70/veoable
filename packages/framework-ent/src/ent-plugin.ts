import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createEntVisitor } from './visitor.js';

/**
 * Ent framework plugin (Phase 5e of #474).
 *
 * Detects ent code-generated CRUD on the generated client:
 *
 *   u, err := client.User.Create().SetName("alice").Save(ctx)
 *   users, err := client.User.Query().Where(...).All(ctx)
 *   client.User.Update().Where(...).SetAge(31).Save(ctx)
 *   client.User.Delete().Where(...).Exec(ctx)
 *   u, err := client.User.Get(ctx, 1)
 *
 * Activation: `entgo.io/ent` in go.mod. (We can't pin a fallback to
 * the user's generated package since its path is project-specific —
 * the entgo.io/ent module itself is the runtime dependency.)
 */
export const ENT_PLUGIN_ID = 'ent' as const;

export class EntPlugin implements FrameworkPlugin {
  readonly id = ENT_PLUGIN_ID;
  readonly language = 'go';

  private _visitor: GoFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasGoModule(ctx, 'entgo.io/ent');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'other', name: 'ent' }),
      kind: 'other',
      name: 'ent',
      connectionSource: 'go-module',
    };
    this._visitor = createEntVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): GoFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'other', name: 'ent' });
      this._visitor = createEntVisitor(systemId);
    }
    return this._visitor;
  }
}
