import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createPymongoVisitor } from './visitor.js';

/**
 * PyMongo framework plugin — Python's MongoDB driver.
 *
 * Fills the missing NoSQL category for Python. Mirrors how the SQL
 * plugins (sqlx, knex, gosqlx, seaorm) emit DatabaseInteraction +
 * DatabaseTable + READS/WRITES edges, except the "table" here is a
 * MongoDB collection.
 *
 * Detected shapes:
 *
 *   client = MongoClient('mongodb://...')
 *   db = client['mydb']
 *   users = db['users']            # attribute-style equivalent: db.users
 *
 *   users.find_one({'_id': 1})
 *   users.find({'active': True})
 *   users.insert_one({'name': 'x'})
 *   users.insert_many([...])
 *   users.update_one(filter, update)
 *   users.update_many(filter, update)
 *   users.delete_one(filter)
 *   users.delete_many(filter)
 *   users.replace_one(filter, doc)
 *   users.aggregate(pipeline)
 *   users.count_documents(filter)
 *
 * Activation: `pymongo` OR `motor` (async PyMongo wrapper, same
 * surface).
 */
export const PYMONGO_PLUGIN_ID = 'pymongo' as const;

export class PymongoPlugin implements FrameworkPlugin {
  readonly id = PYMONGO_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'pymongo') || hasPythonPackage(ctx, 'motor');
  }

  onProjectLoaded(_ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'mongodb', name: 'pymongo' }),
      kind: 'mongodb',
      name: 'pymongo',
      connectionSource: 'python-package',
    };
    this._visitor = createPymongoVisitor(system.id);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'mongodb', name: 'pymongo' });
      this._visitor = createPymongoVisitor(systemId);
    }
    return this._visitor;
  }
}
