import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@veoable/lang-go';
import { extractFirstTableOp } from '@veoable/framework-sqlx';

type SqlOperation = 'read' | 'insert' | 'update' | 'delete';

/**
 * jmoiron/sqlx visitor.
 *
 * Call shape:
 *
 *   db.Get(&dest, "SELECT ...", args...)
 *   db.Select(&dest, "SELECT ...", args...)
 *   db.Queryx("SELECT ...", args...)
 *   db.QueryRowx("SELECT ...", args...)
 *   db.NamedQuery("UPDATE ... :id", arg)
 *   db.NamedExec("INSERT ... :name", arg)
 *   db.MustExec("DELETE ...", arg)
 *   db.Exec("DELETE ...", args...)
 *   tx.Get(...)        // sqlx.Tx has the same methods
 *
 * The SQL is the first string-literal arg for the bare query
 * methods, and the SECOND for Get/Select (which take a dest pointer
 * first). We find the first string literal across the args list —
 * works for both shapes since the dest pointer isn't a string.
 */

const SQLX_METHODS: ReadonlySet<string> = new Set([
  'Get',
  'Select',
  'Queryx',
  'QueryRowx',
  'NamedQuery',
  'NamedExec',
  'MustExec',
  'Exec',
  'Query',
  'QueryRow',
]);

// Conservative receiver-name filter. `db`/`tx`/`conn`/`pool`/`database`
// are the canonical sqlx receivers. `stmt` and `sqlx` are accepted too:
// `stmt.*` is actually a `database/sql` prepared-statement call (not
// jmoiron/sqlx itself), but the go.mod-level activation gate scopes
// the entire universe of files we visit to sqlx-using projects, so
// the call is overwhelmingly a sqlx-prepared statement in practice.
// Heuristic matches by name; common Go method-style `s.db` access via
// a field is also accepted via the optional `<prefix>.` group.
const RECEIVER_RE = /^(?:[a-zA-Z_][\w]*\.)?(db|tx|conn|pool|database|stmt|sqlx)$/i;

export function createGosqlxVisitor(systemId: string): GoFrameworkVisitor {
  const emittedTables = new Set<string>();

  const ensureTable = (ctx: GoVisitContext, name: string): string => {
    const tableId = idFor.databaseTable({ systemId, schema: null, name });
    if (!emittedTables.has(tableId)) {
      emittedTables.add(tableId);
      const table: DatabaseTable = {
        nodeType: 'DatabaseTable',
        id: tableId,
        systemId,
        name,
        schema: null,
        kind: 'table',
        declaredIn: null,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
    }
    return tableId;
  };

  const emit = (ctx: GoVisitContext, callNode: SyntaxNode, sql: string): void => {
    if (!ctx.enclosingFunction) return;
    const parsed = extractFirstTableOp(sql);
    if (!parsed) return;

    const tableId = ensureTable(ctx, parsed.table);
    const operation: DatabaseOperation = toCanonicalOp(parsed.operation);

    const interaction: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        targetTableId: tableId,
      }),
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      orm: 'gosqlx',
      rawQuery: sql.length <= 500 ? sql : null,
      confidence: 'direct',
      evidence: {
        filePath: ctx.sourceFile.filePath,
        lineStart: callNode.startPosition.row + 1,
        lineEnd: callNode.endPosition.row + 1,
        snippet: sql.length <= 500 ? sql : sql.slice(0, 499) + '…',
        confidence: 'exact',
      },
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
      to: ctx.enclosingFunction.id,
      sourceLine: callNode.startPosition.row + 1,
    });
  };

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'selector_expression') return;

      const field = fn.childForFieldName('field');
      const operand = fn.childForFieldName('operand');
      if (!field || !operand) return;

      const methodName = field.text;
      if (!SQLX_METHODS.has(methodName)) return;

      if (!RECEIVER_RE.test(operand.text)) return;

      const args = node.childForFieldName('arguments');
      if (!args) return;

      const sql = findFirstStringArg(args);
      if (sql) emit(ctx, node, sql);
    },
  };
}

function toCanonicalOp(op: SqlOperation): DatabaseOperation {
  switch (op) {
    case 'read': return 'read';
    case 'insert': return 'write';
    case 'update': return 'update';
    case 'delete': return 'delete';
    default: return 'read';
  }
}

function findFirstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === 'interpreted_string_literal') return c.text.slice(1, -1);
    if (c.type === 'raw_string_literal') return c.text.slice(1, -1);
  }
  return null;
}
