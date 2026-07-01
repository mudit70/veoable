import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createMemcachePyVisitor } from './visitor.js';

/**
 * Memcached (Python) framework plugin.
 *
 * Covers `pymemcache` — the dominant Python memcached client.
 * Mirrors framework-memcache-ts emit shape.
 *
 * Activation: `pymemcache` Python package.
 */
export const MEMCACHE_PY_PLUGIN_ID = 'memcache-py' as const;

export class MemcachePyPlugin implements FrameworkPlugin {
  readonly id = MEMCACHE_PY_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'pymemcache') || hasPythonPackage(ctx, 'python-memcached');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'memcached', name: 'memcache-py' }),
      kind: 'memcached',
      name: 'memcache-py',
      connectionSource: 'python-package',
    };
    this._visitor = createMemcachePyVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'memcached', name: 'memcache-py' });
      this._visitor = createMemcachePyVisitor(systemId);
    }
    return this._visitor;
  }
}
