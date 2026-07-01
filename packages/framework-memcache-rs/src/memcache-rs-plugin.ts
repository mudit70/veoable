import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createMemcacheRsVisitor } from './visitor.js';

/**
 * Memcached (Rust) framework plugin.
 *
 * Covers the `memcache` crate. Completes the cross-language
 * Memcached quadfecta after memcache-ts/py/go.
 *
 *   client.get::<String>("key")?
 *   client.set("key", "value", 60)?
 *   client.add("key", "value", 60)?
 *   client.replace("key", "value", 60)?
 *   client.delete("key")?
 *   client.increment("counter", 1)?
 *   client.decrement("counter", 1)?
 *   client.touch("key", 60)?
 *   client.flush()?
 *
 * Activation: `memcache` crate in Cargo.toml. Per-file gate:
 * `use memcache`.
 */
export const MEMCACHE_RS_PLUGIN_ID = 'memcache-rs' as const;

export class MemcacheRsPlugin implements FrameworkPlugin {
  readonly id = MEMCACHE_RS_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'memcache');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'memcached', name: 'memcache-rs' }),
      kind: 'memcached',
      name: 'memcache-rs',
      connectionSource: 'cargo-crate',
    };
    this._visitor = createMemcacheRsVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'memcached', name: 'memcache-rs' });
      this._visitor = createMemcacheRsVisitor(systemId);
    }
    return this._visitor;
  }
}
