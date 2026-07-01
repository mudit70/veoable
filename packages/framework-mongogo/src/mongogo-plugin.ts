import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createMongogoVisitor } from './visitor.js';
import { buildCollectionHelperMap, type CollectionHelperMap } from './helpers-resolver.js';

/**
 * mongo-go-driver framework plugin — Go's MongoDB driver.
 *
 * Detected shapes:
 *
 *   client, _ := mongo.Connect(ctx, opts)
 *   db := client.Database("mydb")
 *   users := db.Collection("users")
 *
 *   users.FindOne(ctx, bson.M{"_id": id})
 *   users.Find(ctx, bson.M{"active": true})
 *   users.InsertOne(ctx, doc)
 *   users.InsertMany(ctx, docs)
 *   users.UpdateOne(ctx, filter, update)
 *   ...
 *
 * Cross-file helper resolution: when a project wraps collection
 * access in a helper (`func Vehicles(...) *mongo.Collection`), the
 * plugin's onProjectLoaded scans every `.go` file for these
 * signatures and threads the bare-name → collection map into the
 * visitor so `col := db.Vehicles(...)` resolves to "vehicles".
 *
 * Activation: `go.mongodb.org/mongo-driver` in any go.mod.
 */
export const MONGOGO_PLUGIN_ID = 'mongogo' as const;

export class MongogoPlugin implements FrameworkPlugin {
  readonly id = MONGOGO_PLUGIN_ID;
  readonly language = 'go';

  private _visitor: GoFrameworkVisitor | null = null;
  private _helpers: CollectionHelperMap | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    return hasGoModule(ctx, 'go.mongodb.org/mongo-driver');
  }

  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'mongodb', name: 'mongogo' }),
      kind: 'mongodb',
      name: 'mongogo',
      connectionSource: 'go-modules',
    };
    this._helpers = buildCollectionHelperMap(ctx.rootDir);
    this._visitor = createMongogoVisitor(system.id, this._helpers);
    return { nodes: [system], edges: [] };
  }

  get visitor(): GoFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'mongodb', name: 'mongogo' });
      this._visitor = createMongogoVisitor(systemId, this._helpers ?? undefined);
    }
    return this._visitor;
  }
}
