import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type DatabaseInteraction } from '@adorable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';

/**
 * GORM framework visitor (#52).
 *
 * Detects database interactions from GORM method calls on *gorm.DB:
 *   db.Find(&users)          → read
 *   db.First(&user, id)      → read
 *   db.Create(&user)         → write
 *   db.Save(&user)           → write (upsert)
 *   db.Update("name", val)   → write
 *   db.Updates(map)          → write
 *   db.Delete(&user, id)     → delete
 *   db.Raw("SQL").Scan(...)  → raw
 *   db.Exec("SQL")           → raw
 *
 * Detection heuristic: method calls on receivers named `db` or `tx`
 * in files importing `gorm.io/gorm`.
 */

const READ_METHODS: ReadonlySet<string> = new Set([
  'Find', 'First', 'Last', 'Take', 'Scan', 'Count', 'Pluck',
]);

const WRITE_METHODS: ReadonlySet<string> = new Set([
  'Create', 'Save', 'Update', 'Updates',
]);

const DELETE_METHODS: ReadonlySet<string> = new Set([
  'Delete',
]);

const RAW_METHODS: ReadonlySet<string> = new Set([
  'Raw', 'Exec',
]);

// Note: Chain methods (Where, Or, Not, Order, Limit, etc.) are handled
// implicitly — isGormReceiver walks through them to find the root db/tx.

export function createGormVisitor(): GoFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!ctx.enclosingFunction) return;
      if (!fileImportsGorm(node, ctx.sourceFile.filePath, fileImportCache)) return;

      const fnNode = node.childForFieldName('function');
      if (!fnNode || fnNode.type !== 'selector_expression') return;

      const field = fnNode.childForFieldName('field');
      if (!field) return;
      const methodName = field.text;

      // Determine operation
      let operation: 'read' | 'write' | 'delete' | 'raw' | null = null;
      if (READ_METHODS.has(methodName)) operation = 'read';
      else if (WRITE_METHODS.has(methodName)) operation = 'write';
      else if (DELETE_METHODS.has(methodName)) operation = 'delete';
      else if (RAW_METHODS.has(methodName)) operation = 'raw';
      else return; // Chain method or unrecognized — skip

      // Check that the receiver chain starts with db/tx
      if (!isGormReceiver(fnNode)) return;

      // Extract raw SQL if Raw/Exec
      let rawQuery: string | null = null;
      if (operation === 'raw') {
        const args = node.childForFieldName('arguments');
        if (args) {
          for (let i = 0; i < args.childCount; i++) {
            const child = args.child(i)!;
            if (child.type === 'interpreted_string_literal' || child.type === 'raw_string_literal') {
              rawQuery = child.text.slice(1, -1);
              break;
            }
          }
        }
      }

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: `table:gorm`, // Best-effort
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'gorm',
        rawQuery,
        confidence: rawQuery ? 'direct' : 'inferred',
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          snippet: node.text.slice(0, 200),
          confidence: 'heuristic',
        },
      };
      ctx.emitNode(interaction);
    },
  };
}

/** Known GORM receiver variable names. */
const GORM_RECEIVERS = new Set(['db', 'tx', 'DB', 'gdb']);

/**
 * Check if a selector expression chain originates from a GORM db/tx receiver.
 * Walks the chain: db.Where(...).Find(...) → operand is call_expression → operand is db
 * M2 fix: Also handles struct field access like s.db.Find() or self.DB.Create()
 */
function isGormReceiver(selectorExpr: SyntaxNode): boolean {
  let current = selectorExpr;
  for (let depth = 0; depth < 10; depth++) {
    const operand = current.childForFieldName('operand') ?? current.childForFieldName('value');
    if (!operand) return false;

    // Direct identifier: db.Find(), tx.Create()
    if (operand.type === 'identifier') {
      return GORM_RECEIVERS.has(operand.text);
    }

    // M2 fix: Struct field access: s.db.Find(), self.DB.Create()
    if (operand.type === 'selector_expression') {
      const field = operand.childForFieldName('field');
      if (field && GORM_RECEIVERS.has(field.text)) return true;
    }

    // Chain: db.Where(...).Find(...) — operand is a call_expression
    if (operand.type === 'call_expression') {
      const fn = operand.childForFieldName('function');
      if (fn && fn.type === 'selector_expression') {
        current = fn;
        continue;
      }
    }

    return false;
  }
  return false;
}

function fileImportsGorm(node: SyntaxNode, filePath: string, cache: Map<string, boolean>): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const root = node.tree.rootNode;
  let has = false;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === 'import_declaration' && child.text.includes('gorm.io/gorm')) {
      has = true;
      break;
    }
  }
  cache.set(filePath, has);
  return has;
}
