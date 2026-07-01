import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createRedisrsVisitor } from './visitor.js';

/**
 * redis (Rust) framework plugin — Rust's mainstream Redis client.
 *
 * Rust analog of framework-redispy + framework-goredis. Closes the
 * Rust cache/KV gap. Models Redis keys as DatabaseTable (kind='table'
 * — closest schema fit for Redis keys) with DatabaseSystem
 * kind='redis'.
 *
 * Detected shapes:
 *
 *   let mut conn = client.get_connection()?;
 *   conn.get::<&str, String>("user:1")?
 *   conn.set("user:1", "value")?
 *   conn.incr::<&str, i64>("counter:requests", 1)?
 *   conn.hset::<&str, &str, String>("user:1:profile", "name", "x")?
 *   conn.lpush("queue:jobs", item)?
 *   conn.del("user:1")?
 *
 * Activation: `redis` crate in Cargo.toml.
 */
export const REDISRS_PLUGIN_ID = 'redisrs' as const;

export class RedisrsPlugin implements FrameworkPlugin {
  readonly id = REDISRS_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'redis');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'redis', name: 'redisrs' }),
      kind: 'redis',
      name: 'redisrs',
      connectionSource: 'cargo-features',
    };
    this._visitor = createRedisrsVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'redis', name: 'redisrs' });
      this._visitor = createRedisrsVisitor(systemId);
    }
    return this._visitor;
  }
}
