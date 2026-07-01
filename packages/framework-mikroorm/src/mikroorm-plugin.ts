import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import { createMikroOrmVisitor } from './visitor.js';

/**
 * MikroORM framework plugin (#372).
 *
 * Two extraction surfaces:
 *   1. `@Entity()`-decorated classes → DatabaseTable + DatabaseColumn
 *      (one per `@Property`/`@PrimaryKey`/etc decorator).
 *   2. CRUD receivers — three shapes:
 *      a. `this.<field>: EntityRepository<X>` → resolves entity
 *         class X (via @Entity decorator), direct confidence.
 *      b. `<em>.<verb>(EntityClass, ...)` where field type is
 *         EntityManager → first-arg-is-entity, direct confidence.
 *      c. Name-heuristic fallback at inferred confidence.
 */

export const MIKROORM_PLUGIN_ID = 'mikroorm' as const;

export class MikroOrmPlugin implements FrameworkPlugin {
  readonly id = MIKROORM_PLUGIN_ID;
  readonly language = 'ts';

  private _visitor: TsFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    // Check the merged-root packageJson AND every per-subpackage
    // manifest. Monorepos like medusa declare @mikro-orm/* in a
    // build-aggregator package (`packages/deps/`) but not in each
    // consumer sub-repo — without scanning manifests we'd miss
    // activation.
    const sources: Array<Record<string, unknown>> = [];
    if (ctx.packageJson) sources.push(ctx.packageJson);
    for (const m of ctx.manifests ?? []) sources.push(m.packageJson);
    for (const pkg of sources) {
      const deps = {
        ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
        ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
        ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
      };
      for (const k of Object.keys(deps)) {
        if (k === '@mikro-orm/core' || k.startsWith('@mikro-orm/')) return true;
        // #383 — Medusa v2 exposes a `model.define(...)` builder on
        // top of MikroORM. The consumer modules declare
        // `@medusajs/framework` (or `@medusajs/utils`) rather than
        // `@mikro-orm/*` directly; without this branch the visitor
        // never runs on the modules where the real schema lives.
        if (k === '@medusajs/framework' || k === '@medusajs/utils') return true;
      }
    }
    return false;
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'mikroorm' }),
      kind: 'postgres',
      name: 'mikroorm',
      connectionSource: 'mikro-orm-config',
    };
    this._visitor = createMikroOrmVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'mikroorm' });
      this._visitor = createMikroOrmVisitor(systemId);
    }
    return this._visitor;
  }
}
