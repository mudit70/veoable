import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createMemcacheGoVisitor } from './visitor.js';

/**
 * Memcached (Go) framework plugin.
 *
 * Covers `github.com/bradfitz/gomemcache/memcache`. Mirrors
 * framework-memcache-ts/py.
 *
 * Detected verbs (10):
 *   mc.Get("key")                  — read
 *   mc.GetMulti(keys)              — read
 *   mc.Set(&memcache.Item{Key: "k", Value: v})  — update
 *   mc.Add(&memcache.Item{...})    — insert
 *   mc.Replace(&memcache.Item{...}) — update
 *   mc.Increment("k", 1)           — update
 *   mc.Decrement("k", 1)           — update
 *   mc.Touch("k", 60)              — update
 *   mc.Delete("k")                 — delete
 *   mc.DeleteAll()                 — delete
 *   mc.FlushAll()                  — delete
 *
 * Activation: `github.com/bradfitz/gomemcache` in go.mod.
 */
export const MEMCACHE_GO_PLUGIN_ID = 'memcache-go' as const;

export class MemcacheGoPlugin implements FrameworkPlugin {
  readonly id = MEMCACHE_GO_PLUGIN_ID;
  readonly language = 'go';

  private _visitor: GoFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasGoModule(ctx, 'github.com/bradfitz/gomemcache');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'memcached', name: 'memcache-go' }),
      kind: 'memcached',
      name: 'memcache-go',
      connectionSource: 'go-module',
    };
    this._visitor = createMemcacheGoVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): GoFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'memcached', name: 'memcache-go' });
      this._visitor = createMemcacheGoVisitor(systemId);
    }
    return this._visitor;
  }
}
