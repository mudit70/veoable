import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import { idFor, type DatabaseSystem } from '@adorable/schema';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createElasticGoVisitor } from './visitor.js';

/**
 * Elasticsearch (Go) framework plugin.
 *
 * Mirrors framework-elastic-ts / framework-elastic-py. Covers
 * `github.com/elastic/go-elasticsearch/v8` (and v7).
 *
 * Detected call shapes:
 *
 *   es.Index("users", strings.NewReader(doc))
 *   es.Get("users", "1")
 *   es.Update("users", "1", strings.NewReader(updateDoc))
 *   es.Delete("users", "1")
 *   es.Search(es.Search.WithIndex("users"), ...)
 *
 * For Index/Get/Update/Delete, the first positional string arg is
 * the index. For Search, scan the args for
 * `<recv>.Search.WithIndex("name")` patterns.
 *
 * Activation: `github.com/elastic/go-elasticsearch` in go.mod (any
 * version).
 */
export const ELASTIC_GO_PLUGIN_ID = 'elastic-go' as const;

export class ElasticGoPlugin implements FrameworkPlugin {
  readonly id = ELASTIC_GO_PLUGIN_ID;
  readonly language = 'go';

  private _visitor: GoFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return (
      hasGoModule(ctx, 'github.com/elastic/go-elasticsearch/v8')
      || hasGoModule(ctx, 'github.com/elastic/go-elasticsearch/v7')
      || hasGoModule(ctx, 'github.com/elastic/go-elasticsearch')
    );
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-go' }),
      kind: 'elasticsearch',
      name: 'elastic-go',
      connectionSource: 'go-module',
    };
    this._visitor = createElasticGoVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): GoFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-go' });
      this._visitor = createElasticGoVisitor(systemId);
    }
    return this._visitor;
  }
}
