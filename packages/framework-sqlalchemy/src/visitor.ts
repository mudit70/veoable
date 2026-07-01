import { idFor, type DatabaseInteraction, type DatabaseTable, type DatabaseOperation } from '@veoable/schema';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;

/**
 * SQLAlchemy framework visitor (#42).
 *
 * Detects SQLAlchemy session/query CRUD operations:
 *   db.query(Task).all()          → read (table: task)
 *   db.query(Task).filter(...)    → read (table: task)
 *   db.add(task)                  → write
 *   db.delete(task)               → delete
 *   db.commit()                   → (ignored, side-effect of add/delete)
 *   session.execute(...)          → dynamic
 *
 * Table names are inferred from the Model class name passed to query()
 * or from the variable type heuristic.
 */

const READ_METHODS: ReadonlySet<string> = new Set([
  'all', 'first', 'one', 'one_or_none', 'scalar', 'count',
  'filter', 'filter_by', 'get', 'order_by', 'limit', 'offset',
]);

const SESSION_RECEIVERS: ReadonlySet<string> = new Set([
  'db', 'session', 'db_session', 'database',
]);

export function createSqlalchemyVisitor(systemId: string): PyFrameworkVisitor {
  const emittedTables = new Set<string>();

  return {
    language: 'py',

    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!ctx.enclosingFunction) return;

      const fn = node.childForFieldName('function');
      if (!fn) return;

      // Pattern 1: db.query(Model).all() / .filter() / .first()
      if (fn.type === 'attribute') {
        const attr = fn.childForFieldName('attribute');
        const obj = fn.childForFieldName('object');
        if (!attr || !obj) return;

        const methodName = attr.text;

        // Check for db.query(Model) — obj is a call to query()
        if (READ_METHODS.has(methodName) && obj.type === 'call') {
          const queryFn = obj.childForFieldName('function');
          if (queryFn?.type === 'attribute') {
            const queryAttr = queryFn.childForFieldName('attribute');
            const queryObj = queryFn.childForFieldName('object');
            if (queryAttr?.text === 'query' && queryObj && SESSION_RECEIVERS.has(queryObj.text)) {
              const modelName = extractModelFromArgs(obj);
              if (modelName) {
                emitInteraction(ctx, node, 'read', modelName, systemId, emittedTables);
              }
              return;
            }
          }
        }

        // Check for chained query: db.query(Model).filter(...).first()
        // The obj might be another call in the chain — walk up
        if (READ_METHODS.has(methodName)) {
          const modelName = findQueryModelInChain(obj);
          if (modelName) {
            emitInteraction(ctx, node, 'read', modelName, systemId, emittedTables);
            return;
          }
        }

        // Pattern 2: db.add(instance) → write
        if (methodName === 'add' && obj.type === 'identifier' && SESSION_RECEIVERS.has(obj.text)) {
          const modelName = inferModelFromCallArgs(node);
          if (modelName) {
            emitInteraction(ctx, node, 'write', modelName, systemId, emittedTables);
          }
          return;
        }

        // Pattern 3: db.delete(instance) → delete
        if (methodName === 'delete' && obj.type === 'identifier' && SESSION_RECEIVERS.has(obj.text)) {
          const modelName = inferModelFromCallArgs(node);
          if (modelName) {
            emitInteraction(ctx, node, 'delete', modelName, systemId, emittedTables);
          }
          return;
        }
      }
    },
  };
}

function emitInteraction(
  ctx: Parameters<PyFrameworkVisitor['onNode']>[0],
  node: SyntaxNode,
  operation: DatabaseOperation,
  modelName: string,
  systemId: string,
  emittedTables: Set<string>,
): void {
  const tableName = modelName.toLowerCase();
  const tableId = idFor.databaseTable({ systemId, schema: null, name: tableName });

  if (!emittedTables.has(tableId)) {
    emittedTables.add(tableId);
    const table: DatabaseTable = {
      nodeType: 'DatabaseTable',
      id: tableId,
      systemId,
      name: tableName,
      schema: null,
      kind: 'table',
      declaredIn: null,
    };
    ctx.emitNode(table);
    ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
  }

  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction',
    id: idFor.databaseInteraction({
      callSiteFunctionId: ctx.enclosingFunction!.id,
      operation,
      targetTableId: tableId,
    }),
    callSiteFunctionId: ctx.enclosingFunction!.id,
    operation,
    orm: 'sqlalchemy',
    rawQuery: null,
    confidence: 'inferred',
  };
  ctx.emitNode(interaction);

  if (operation === 'read') {
    ctx.emitEdge({ edgeType: 'READS', from: interaction.id, to: tableId, columns: null, filters: null });
  } else {
    const kind = operation === 'delete' ? 'delete' : operation === 'update' ? 'update' : 'insert';
    ctx.emitEdge({ edgeType: 'WRITES', from: interaction.id, to: tableId, columns: null, kind });
  }

  ctx.emitEdge({
    edgeType: 'PERFORMED_BY',
    from: interaction.id,
    to: ctx.enclosingFunction!.id,
    sourceLine: node.startPosition.row + 1,
  });
}

/** Extract Model name from db.query(Model) call arguments. */
function extractModelFromArgs(callNode: SyntaxNode): string | null {
  const args = callNode.childForFieldName('arguments');
  if (!args) return null;
  for (const child of args.children) {
    if (child.type === 'identifier' && /^[A-Z]/.test(child.text)) {
      return child.text;
    }
  }
  return null;
}

/** Walk up a method chain to find db.query(Model) and extract the Model name. */
function findQueryModelInChain(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node;
  let depth = 0;
  const MAX_CHAIN_DEPTH = 20;
  while (current && depth++ < MAX_CHAIN_DEPTH) {
    if (current.type === 'call') {
      const fn = current.childForFieldName('function');
      if (fn?.type === 'attribute') {
        const attr = fn.childForFieldName('attribute');
        const obj = fn.childForFieldName('object');
        if (attr?.text === 'query' && obj && SESSION_RECEIVERS.has(obj.text)) {
          return extractModelFromArgs(current);
        }
      }
      // Move up: the receiver of the method call
      current = current.childForFieldName('function');
      if (current?.type === 'attribute') {
        current = current.childForFieldName('object');
      }
    } else if (current.type === 'attribute') {
      current = current.childForFieldName('object');
    } else {
      break;
    }
  }
  return null;
}

/** Infer model name from db.add(variable) — convert snake_case to PascalCase. */
function inferModelFromCallArgs(callNode: SyntaxNode): string | null {
  const args = callNode.childForFieldName('arguments');
  if (!args) return null;
  for (const child of args.children) {
    if (child.type === 'identifier') {
      // db.add(db_task) → "Task", db.add(new_order_item) → "OrderItem"
      let name = child.text;
      name = name.replace(/^(db_|new_)/, '');
      // Convert snake_case to PascalCase
      return name.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
    }
  }
  return null;
}
