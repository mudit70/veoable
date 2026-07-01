import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createIoredisVisitor } from './visitor.js';

/**
 * ioredis / node-redis framework plugin — TypeScript's dominant
 * Redis clients. Completes the cross-language Redis quadfecta after
 * framework-redispy (Python), framework-goredis (Go), and
 * framework-redisrs (Rust). Mirrors their `DatabaseInteraction` +
 * `DatabaseTable` (kind='table') emit shape, with `kind='redis'`
 * on the synthesized `DatabaseSystem`.
 *
 * Detected verbs (~50):
 *   GET / MGET / HGET / HMGET / HGETALL / LRANGE / SMEMBERS / ...
 *   SET / SETEX / SETNX / INCR / INCRBY / DECR / HSET / LPUSH / RPUSH /
 *     SADD / ZADD / EXPIRE / PUBLISH / ...
 *   DEL / UNLINK / FLUSHDB / FLUSHALL / HDEL / SREM / ZREM / LPOP / RPOP
 *
 * Activation: `ioredis` OR `redis` (node-redis) in package.json deps.
 */
export const IOREDIS_PLUGIN_ID = 'ioredis' as const;

export class IoredisPlugin implements FrameworkPlugin {
  readonly id = IOREDIS_PLUGIN_ID;
  readonly language = 'ts';

  private _visitor: TsFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'ioredis' in deps || 'redis' in deps;
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'redis', name: 'ioredis' }),
      kind: 'redis',
      name: 'ioredis',
      connectionSource: 'npm-package',
    };
    this._visitor = createIoredisVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'redis', name: 'ioredis' });
      this._visitor = createIoredisVisitor(systemId);
    }
    return this._visitor;
  }
}
