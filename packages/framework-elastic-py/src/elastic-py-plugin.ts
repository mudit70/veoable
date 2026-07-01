import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasPythonPackage } from '@adorable/plugin-api';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import { createElasticPyVisitor } from './visitor.js';

/**
 * Elasticsearch (Python) framework plugin.
 *
 * Mirrors framework-elastic-ts (Phase 3a). Covers the official
 * `elasticsearch` library — both `Elasticsearch` (sync) and
 * `AsyncElasticsearch` (async). Both expose the same verb names.
 *
 * Detected verbs (~12):
 *   es.index(index='X', document={...})       — write
 *   es.search(index='X', body={...})           — read
 *   es.get(index='X', id='...')                — read
 *   es.delete(index='X', id='...')             — delete
 *   es.update(index='X', id='...', body={...}) — update
 *   es.bulk(body=[...])                         — write
 *   es.count / exists / mget / msearch
 *
 * Activation: `elasticsearch` Python package.
 */
export const ELASTIC_PY_PLUGIN_ID = 'elastic-py' as const;

export class ElasticPyPlugin implements FrameworkPlugin {
  readonly id = ELASTIC_PY_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'elasticsearch');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-py' }),
      kind: 'elasticsearch',
      name: 'elastic-py',
      connectionSource: 'python-package',
    };
    this._visitor = createElasticPyVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-py' });
      this._visitor = createElasticPyVisitor(systemId);
    }
    return this._visitor;
  }
}
