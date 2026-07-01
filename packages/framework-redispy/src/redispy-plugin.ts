import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasPythonPackage } from '@adorable/plugin-api';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createRedispyVisitor } from './visitor.js';

/**
 * redis-py framework plugin — Python's dominant Redis client.
 *
 * Closes the cache/KV gap for Python. Models Redis commands as
 * DatabaseInteraction with DatabaseSystem kind='redis'. The "table"
 * name is the key literal (or the LITERAL PREFIX of a formatted key
 * like `user:{uid}` → `user:*`).
 *
 * Detected verbs:
 *   GET / MGET / GETSET / HGET / HMGET / HGETALL / LRANGE /
 *     SMEMBERS / SISMEMBER / ZRANGE / ZSCORE / EXISTS / TYPE
 *   SET / SETEX / SETNX / INCR / INCRBY / DECR / DECRBY /
 *     HSET / HMSET / HINCRBY / LPUSH / RPUSH / SADD / SREM /
 *     ZADD / ZREM / EXPIRE / PERSIST / RENAME
 *   DEL / UNLINK / FLUSHDB / FLUSHALL / HDEL
 *   PUBLISH (write), SUBSCRIBE / PSUBSCRIBE (read)
 *
 * Activation: `redis` Python package (the official redis-py client,
 * NOT to be confused with the deprecated `redis-py-cluster`).
 */
export const REDISPY_PLUGIN_ID = 'redispy' as const;

export class RedispyPlugin implements FrameworkPlugin {
  readonly id = REDISPY_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'redis') || hasPythonPackage(ctx, 'aioredis');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'redis', name: 'redispy' }),
      kind: 'redis',
      name: 'redispy',
      connectionSource: 'python-package',
    };
    this._visitor = createRedispyVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'redis', name: 'redispy' });
      this._visitor = createRedispyVisitor(systemId);
    }
    return this._visitor;
  }
}
