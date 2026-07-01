import { Node, type CallExpression } from 'ts-morph';
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence, resolveToString } from '@veoable/lang-ts';

/**
 * Knex visitor (#369).
 *
 * Two extraction surfaces:
 *
 *   1. **Table synthesis** — `knex('users')` / `db('users')` style
 *      calls produce a synthetic `DatabaseTable` keyed on the
 *      string argument. The same name is reused across call sites
 *      via dedup.
 *
 *   2. **Operation detection** — chained `.select()` / `.insert(...)`
 *      / `.update(...)` / `.delete()` / `.where()` calls on a
 *      `knex(<table>)` builder. The chain is walked to find the
 *      relevant terminal verb. `.raw(...)` calls (and
 *      `knex.raw(...)`) emit a raw operation at dynamic confidence.
 *
 * The receiver `knex` / `db` / `database` / `this.knex` / `this.db`
 * is matched by name; the table is identified by the literal string
 * arg at the chain head.
 */

const RECEIVER_RE = /^(?:this\.)?(knex|db|database|trx|qb)$/;

const READ_VERBS: ReadonlySet<string> = new Set([
  'select', 'first', 'pluck', 'count', 'min', 'max', 'sum', 'avg',
]);
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'insert',
]);
const UPDATE_VERBS: ReadonlySet<string> = new Set([
  'update', 'increment', 'decrement',
]);
const DELETE_VERBS: ReadonlySet<string> = new Set([
  'del', 'delete', 'truncate',
]);

export function createKnexVisitor(systemId: string): TsFrameworkVisitor {
  const emittedTables = new Set<string>();

  const ensureTable = (
    ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
    tableName: string,
    declaredIn: string | null,
  ): string => {
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
        declaredIn,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
    }
    return tableId;
  };

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!ctx.enclosingFunction) return;

      const callee = node.getExpression();

      // #369 — `knex.raw(...)` / `db.raw(...)` — raw query.
      if (Node.isPropertyAccessExpression(callee)) {
        const methodName = callee.getNameNode().getText();
        if (methodName === 'raw' && isKnexReceiver(callee.getExpression())) {
          emitInteraction(ctx, systemId, null, 'raw', 'dynamic', node);
          return;
        }
      }

      // #369 — fluent verb at the tail of a `knex('table').<verb>(...)` chain.
      if (Node.isPropertyAccessExpression(callee)) {
        const methodName = callee.getNameNode().getText();
        let operation: DatabaseOperation | null = null;
        if (READ_VERBS.has(methodName)) operation = 'read';
        else if (WRITE_VERBS.has(methodName)) operation = 'write';
        else if (UPDATE_VERBS.has(methodName)) operation = 'update';
        else if (DELETE_VERBS.has(methodName)) operation = 'delete';
        if (!operation) return;

        const tableName = findKnexTableInChain(callee.getExpression());
        if (!tableName) return;

        const tableId = ensureTable(ctx, tableName, ctx.sourceFile.filePath);
        emitInteraction(ctx, systemId, tableId, operation, 'direct', node);
        return;
      }
    },
  };
}

function isKnexReceiver(node: Node): boolean {
  return RECEIVER_RE.test(node.getText());
}

/**
 * Walk down a `<recv>('table').foo(...).bar(...).<verb>(...)` chain
 * to find the table-name string at the head call. Accepts either:
 *   - a string-literal arg: `knex('users')`
 *   - any expression `resolveToString` (lang-ts) can const-fold to a
 *     string, including identifiers, object-property accesses, and
 *     enum members (#386).
 */
function findKnexTableInChain(node: Node): string | null {
  let current: Node | null = node;
  while (current) {
    if (Node.isCallExpression(current)) {
      const callee = current.getExpression();
      if (Node.isIdentifier(callee) || Node.isPropertyAccessExpression(callee)) {
        if (isKnexReceiver(callee)) {
          const args = current.getArguments();
          if (args.length === 0) return null;
          const first = args[0];
          if (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) {
            return first.getLiteralValue();
          }
          // #386 — const-propagate non-literal args. Catches
          //   knex(USERS_TABLE).select(...)
          //   knex(Tables.USERS).insert(...)
          //   const t = 'users'; knex(t).first()
          const resolved = resolveToString(first);
          if (resolved) return resolved;
          return null;
        }
        // Walk further down the chain.
        if (Node.isPropertyAccessExpression(callee)) {
          current = callee.getExpression();
          continue;
        }
        return null;
      }
      return null;
    }
    if (Node.isPropertyAccessExpression(current)) {
      current = current.getExpression();
      continue;
    }
    return null;
  }
  return null;
}

function emitInteraction(
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  _systemId: string,
  tableId: string | null,
  operation: DatabaseOperation,
  confidence: 'direct' | 'inferred' | 'dynamic',
  node: CallExpression,
): void {
  if (!ctx.enclosingFunction) return;
  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction',
    id: idFor.databaseInteraction({
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      targetTableId: tableId ?? 'knex-raw',
    }),
    callSiteFunctionId: ctx.enclosingFunction.id,
    operation,
    orm: 'knex',
    rawQuery: null,
    confidence,
    evidence: buildEvidence(node, ctx.sourceFile.filePath),
  };
  ctx.emitNode(interaction);
  if (tableId) {
    if (operation === 'read') {
      ctx.emitEdge({ edgeType: 'READS', from: interaction.id, to: tableId, columns: null, filters: null });
    } else if (operation === 'write' || operation === 'update' || operation === 'delete') {
      const kind = operation === 'delete' ? 'delete' : operation === 'update' ? 'update' : 'insert';
      ctx.emitEdge({ edgeType: 'WRITES', from: interaction.id, to: tableId, columns: null, kind });
    }
  }
  ctx.emitEdge({
    edgeType: 'PERFORMED_BY',
    from: interaction.id,
    to: ctx.enclosingFunction.id,
    sourceLine: node.getStartLineNumber(),
  });
}
