import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createElasticTsVisitor } from './visitor.js';

/**
 * Elasticsearch (TypeScript) framework plugin.
 *
 * Covers `@elastic/elasticsearch` v8. Models ES indices as
 * DatabaseTable nodes (with kind='collection' as the closest fit
 * for an ES index) under a DatabaseSystem with kind='elasticsearch'
 * (added in PR #475).
 *
 * Detected verbs (~10):
 *   client.index({ index, document })       — write
 *   client.search({ index, query })          — read
 *   client.get({ index, id })                — read
 *   client.delete({ index, id })             — delete
 *   client.update({ index, id, doc })        — update
 *   client.bulk({ operations })              — write (per-op
 *                                              skipped; index field
 *                                              is per-operation,
 *                                              not top-level)
 *   client.count({ index })                  — read
 *   client.exists({ index, id })             — read
 *   client.mget({ index })                   — read
 *   client.msearch({ searches })             — read
 *
 * Activation: `@elastic/elasticsearch` in package.json deps.
 * Per-file gate: any import from `@elastic/elasticsearch`.
 */
export const ELASTIC_TS_PLUGIN_ID = 'elastic-ts' as const;

export class ElasticTsPlugin implements FrameworkPlugin {
  readonly id = ELASTIC_TS_PLUGIN_ID;
  readonly language = 'ts';

  private _visitor: TsFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return '@elastic/elasticsearch' in deps;
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-ts' }),
      kind: 'elasticsearch',
      name: 'elastic-ts',
      connectionSource: 'npm-package',
    };
    this._visitor = createElasticTsVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-ts' });
      this._visitor = createElasticTsVisitor(systemId);
    }
    return this._visitor;
  }
}
