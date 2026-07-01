import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createMemcacheTsVisitor } from './visitor.js';

/**
 * Memcached (TypeScript) framework plugin.
 *
 * Covers `memjs` — the dominant Node memcached client. Uses the
 * `'memcached'` DatabaseKind added in Phase 0 (#475).
 *
 * Detected verbs (~9):
 *   client.get(key)
 *   client.set(key, value, opts)
 *   client.delete(key)
 *   client.increment(key, amount)
 *   client.decrement(key, amount)
 *   client.add(key, value, opts)
 *   client.replace(key, value, opts)
 *   client.touch(key, ttl)
 *   client.flush()
 *
 * Activation: `memjs` in package.json. Per-file gate: import from
 * `memjs`.
 */
export const MEMCACHE_TS_PLUGIN_ID = 'memcache-ts' as const;

export class MemcacheTsPlugin implements FrameworkPlugin {
  readonly id = MEMCACHE_TS_PLUGIN_ID;
  readonly language = 'ts';

  private _visitor: TsFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'memjs' in deps;
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'memcached', name: 'memcache-ts' }),
      kind: 'memcached',
      name: 'memcache-ts',
      connectionSource: 'npm-package',
    };
    this._visitor = createMemcacheTsVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'memcached', name: 'memcache-ts' });
      this._visitor = createMemcacheTsVisitor(systemId);
    }
    return this._visitor;
  }
}
