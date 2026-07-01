import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createGoredisVisitor } from './visitor.js';

/**
 * go-redis framework plugin — Go's dominant Redis client.
 *
 * Closes the Go cache/KV gap. Models Redis commands as
 * DatabaseInteraction with DatabaseSystem kind='redis'. The "table"
 * name is the key literal (or the literal prefix of a fmt.Sprintf
 * pattern like `fmt.Sprintf("user:%d", id)` → `user:*`).
 *
 * Detected shapes:
 *
 *   rdb := redis.NewClient(...)
 *   rdb.Get(ctx, "user:1")
 *   rdb.Set(ctx, "user:1", value, time.Hour)
 *   rdb.HGet(ctx, "user:profile", "name")
 *   rdb.LPush(ctx, "queue:jobs", item)
 *
 * Activation: `github.com/redis/go-redis` OR
 * `github.com/go-redis/redis` (legacy module path).
 */
export const GOREDIS_PLUGIN_ID = 'goredis' as const;

export class GoredisPlugin implements FrameworkPlugin {
  readonly id = GOREDIS_PLUGIN_ID;
  readonly language = 'go';

  private _visitor: GoFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    return hasGoModule(ctx, 'github.com/redis/go-redis')
      || hasGoModule(ctx, 'github.com/go-redis/redis');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'redis', name: 'goredis' }),
      kind: 'redis',
      name: 'goredis',
      connectionSource: 'go-modules',
    };
    this._visitor = createGoredisVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): GoFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'redis', name: 'goredis' });
      this._visitor = createGoredisVisitor(systemId);
    }
    return this._visitor;
  }
}
