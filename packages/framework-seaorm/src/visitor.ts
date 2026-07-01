import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@adorable/schema';
import type { RustFrameworkVisitor, RustVisitContext } from '@adorable/lang-rust';

/**
 * SeaORM visitor.
 *
 * Detected call shapes:
 *   <Entity>::find()                       → read
 *   <Entity>::find_by_id(...)              → read
 *   <Entity>::find_with_related(...)       → read
 *   <Entity>::insert(active_model)         → write (insert)
 *   <Entity>::insert_many(...)             → write (insert)
 *   <Entity>::update(active_model)         → update
 *   <Entity>::update_many()                → update
 *   <Entity>::delete_by_id(...)            → delete
 *   <Entity>::delete_many()                → delete
 *
 * Conservative v1:
 *   - Only the scoped-path form (`Entity::verb(...)`) is detected.
 *     The value-form (`active_model.insert(db)`) requires receiver
 *     type tracking and is deferred.
 *   - Receiver name (`Entity`) must NOT be `Self`/`self` (not real
 *     entity refs).
 *
 * Table-name resolution:
 *   - Per-file scan of top-level `#[sea_orm(table_name = "X")]`
 *     attributes near a struct named `Entity` or `Model`. We index
 *     by the containing module's Entity name when available, but
 *     since the typical pattern is `mod user { struct Entity; use
 *     ... as User }`, the entity LABEL at the call site
 *     (`User::find()`) often differs from the struct name (`Entity`).
 *     We fall back to the snake_case lowercased call-site label as
 *     a heuristic when no explicit table_name is found.
 *   - Future slice: handle `use crate::entity::user::Entity as User`
 *     by tracing the alias to its module and table_name.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  ['find', { op: 'read' }],
  ['find_by_id', { op: 'read' }],
  ['find_with_related', { op: 'read' }],
  ['find_also_related', { op: 'read' }],
  ['find_with_linked', { op: 'read' }],
  ['insert', { op: 'insert' }],
  ['insert_many', { op: 'insert' }],
  ['update', { op: 'update' }],
  ['update_many', { op: 'update' }],
  ['delete_by_id', { op: 'delete' }],
  ['delete_many', { op: 'delete' }],
]);

export function createSeaormVisitor(
  systemId: string,
  projectTableMap: ReadonlyMap<string, string> = new Map(),
): RustFrameworkVisitor {
  const emittedTables = new Set<string>();
  // Per-file lookup of (entityName → table_name) when explicit.
  const tableNameByFile = new Map<string, Map<string, string>>();
  const getTableMap = (filePath: string, root: SyntaxNode): Map<string, string> => {
    let m = tableNameByFile.get(filePath);
    if (!m) {
      m = scanModuleForTableNames(root);
      tableNameByFile.set(filePath, m);
    }
    return m;
  };

  // Per-file map of (variable name → entity hint). Built once per
  // file from `let <var> = <Entity>ActiveModel::default()` and
  // `let <var>: <Entity>ActiveModel = ...` shapes. Lets the
  // value-form heuristic recognize `am.insert(db)` even when the
  // receiver isn't itself a PascalCase ActiveModel type.
  const amVarsByFile = new Map<string, Map<string, string>>();
  const getAmVars = (filePath: string, root: SyntaxNode): Map<string, string> => {
    let m = amVarsByFile.get(filePath);
    if (!m) {
      m = scanFileForActiveModelBindings(root);
      amVarsByFile.set(filePath, m);
    }
    return m;
  };

  const resolveTable = (entityLabel: string, perFileMap: Map<string, string>): string => {
    // Direct alias match in the project-wide map (best).
    const direct = projectTableMap.get(entityLabel);
    if (direct) return direct;
    // Per-file table_name attribute keyed by entity label.
    const perFile = perFileMap.get(entityLabel);
    if (perFile) return perFile;
    // Project-wide 'Entity' fallback (when the alias chain
    // resolution missed but a table_name was found in SOME file).
    const projEntity = projectTableMap.get('Entity');
    if (projEntity) return projEntity;
    // Per-file 'Entity' magic key.
    const perFileEntity = perFileMap.get('Entity');
    if (perFileEntity) return perFileEntity;
    // Fallback: snake_case + naive pluralization.
    return pluralize(toSnakeCase(entityLabel));
  };

  const ensureTable = (ctx: RustVisitContext, name: string): string => {
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

  const emitInteraction = (
    ctx: RustVisitContext,
    node: SyntaxNode,
    tableName: string,
    op: 'read' | 'insert' | 'update' | 'delete',
    confidence: 'direct' | 'inferred',
  ): void => {
    if (!ctx.enclosingFunction) return;
    const tableId = ensureTable(ctx, tableName);
    const operation: DatabaseOperation = toCanonicalOp(op);

    const interaction: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        targetTableId: tableId,
      }),
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      orm: 'seaorm',
      rawQuery: null,
      confidence,
      evidence: {
        filePath: ctx.sourceFile.filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        snippet: node.text.slice(0, 200),
        confidence: confidence === 'direct' ? 'exact' : 'heuristic',
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
      sourceLine: node.startPosition.row + 1,
    });
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (!fn) return;

      // ── Form 1: Entity::verb(...) ─────────────────────────────
      const parsed = parseEntityVerbCall(fn);
      if (parsed) {
        const map = getTableMap(ctx.sourceFile.filePath, node.tree.rootNode);
        const tableName = resolveTable(parsed.entity, map);
        emitInteraction(ctx, node, tableName, parsed.op, 'direct');
        return;
      }

      // ── Form 2: <ActiveModelLike>.insert/update/delete(db) ────
      // Real SeaORM code overwhelmingly writes via the ActiveModel
      // value form. Heuristic: receiver text contains 'ActiveModel'
      // or matches a `<Entity>ActiveModel`-like variable name. Table
      // resolution: strip the 'ActiveModel' suffix to get the entity
      // label, then resolve via the project map.
      const amVars = getAmVars(ctx.sourceFile.filePath, node.tree.rootNode);
      const valueForm = parseActiveModelValueForm(fn, amVars);
      if (valueForm) {
        const entityFromActiveModel =
          valueForm.entityHintEntity
          ?? stripActiveModelSuffix(valueForm.entityHintReceiverText);
        const tableName = entityFromActiveModel
          ? resolveTable(entityFromActiveModel, getTableMap(ctx.sourceFile.filePath, node.tree.rootNode))
          : 'unknown';
        emitInteraction(ctx, node, tableName, valueForm.op, 'inferred');
        return;
      }
    },
  };
}

function toCanonicalOp(op: 'read' | 'insert' | 'update' | 'delete'): DatabaseOperation {
  switch (op) {
    case 'read': return 'read';
    case 'insert': return 'write';
    case 'update': return 'update';
    case 'delete': return 'delete';
    default: return 'read';
  }
}

interface EntityVerbCall {
  entity: string;
  op: 'read' | 'insert' | 'update' | 'delete';
}

function parseEntityVerbCall(fn: SyntaxNode): EntityVerbCall | null {
  if (fn.type !== 'scoped_identifier') return null;
  const path = fn.childForFieldName('path');
  const name = fn.childForFieldName('name');
  if (!path || !name) return null;

  const verb = VERBS.get(name.text);
  if (!verb) return null;

  // path can be 'User' (type_identifier wrapped in identifier) or
  // 'crate::entity::user::Entity'. For our purpose the LAST segment
  // is the entity label.
  const entityName = lastPathSegment(path.text);
  if (!entityName) return null;
  if (entityName === 'Self' || entityName === 'self') return null;
  // Heuristic: entity names start with an uppercase letter — drops
  // function-name false-positives like `parse::find(...)`.
  if (!/^[A-Z]/.test(entityName)) return null;
  // Reject SeaORM internal types that are NOT entities. These often
  // appear at the tail of a scoped path (`User::Column::find_by_*`,
  // `User::Relation::find`) and would otherwise misfire.
  if (ENTITY_REJECT_LIST.has(entityName)) return null;

  return { entity: entityName, op: verb.op };
}

const ENTITY_REJECT_LIST: ReadonlySet<string> = new Set([
  'Column',
  'Relation',
  'PrimaryKey',
  'ActiveModel',
  'Model',
  'Entity',
]);

interface ActiveModelCall {
  /** Resolved entity name from a per-file let-binding scan. */
  entityHintEntity: string | null;
  /** The raw receiver text — fallback for stripActiveModelSuffix. */
  entityHintReceiverText: string;
  op: 'insert' | 'update' | 'delete';
}

const ACTIVE_MODEL_VERBS: ReadonlySet<string> = new Set(['insert', 'update', 'delete']);

/**
 * Match `<receiver>.insert(db)` / `.update(db)` / `.delete(db)` where
 * the receiver is recognized as an ActiveModel either:
 *   (a) the receiver text contains the literal substring 'ActiveModel'
 *       (rare — direct type-name receiver), OR
 *   (b) the receiver is a variable in the per-file `amVars` map (the
 *       common case — `let am = UserActiveModel::default(); am.insert
 *       (db)`).
 */
function parseActiveModelValueForm(
  fn: SyntaxNode,
  amVars: ReadonlyMap<string, string>,
): ActiveModelCall | null {
  if (fn.type !== 'field_expression') return null;
  const fieldNode = fn.childForFieldName('field');
  const valueNode = fn.childForFieldName('value');
  if (!fieldNode || !valueNode) return null;
  const methodName = fieldNode.text;
  if (!ACTIVE_MODEL_VERBS.has(methodName)) return null;
  const receiverText = valueNode.text;

  const entityFromVar = amVars.get(receiverText);
  if (entityFromVar) {
    return {
      entityHintEntity: entityFromVar,
      entityHintReceiverText: receiverText,
      op: methodName as 'insert' | 'update' | 'delete',
    };
  }
  if (receiverText.includes('ActiveModel')) {
    return {
      entityHintEntity: null,
      entityHintReceiverText: receiverText,
      op: methodName as 'insert' | 'update' | 'delete',
    };
  }
  return null;
}

/**
 * Per-file scan for variables that hold an ActiveModel value. Two
 * shapes:
 *
 *   let am = UserActiveModel::default();          → { am: 'User' }
 *   let am: UserActiveModel = something();        → { am: 'User' }
 *   let am = user::ActiveModel::default();        → { am: 'User' }
 *
 * Conservative — only direct `let` patterns; reassignments and
 * complex destructuring (rare for ActiveModel) are out of scope.
 * Text-based regex is sufficient because real SeaORM code follows
 * the conventional patterns closely.
 */
function scanFileForActiveModelBindings(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  const text = rootNode.text;

  // Shape 1: `let <name>: <Path>ActiveModel = ...`
  // Match the type annotation first.
  const typedRe = /\blet\s+(?:mut\s+)?(\w+)\s*:\s*([\w:]+ActiveModel)\b/g;
  let m: RegExpExecArray | null;
  while ((m = typedRe.exec(text)) !== null) {
    const varName = m[1];
    const entity = entityFromActiveModelPath(m[2]);
    if (entity) out.set(varName, entity);
  }

  // Shape 2: `let <name> = <Path>ActiveModel::default()` and similar
  // constructor-style RHS forms (also `::new(...)`, `::from(...)`).
  const initRe = /\blet\s+(?:mut\s+)?(\w+)\s*=\s*([\w:]+ActiveModel)\s*(?:::\s*\w+\s*\()/g;
  while ((m = initRe.exec(text)) !== null) {
    if (out.has(m[1])) continue;
    const entity = entityFromActiveModelPath(m[2]);
    if (entity) out.set(m[1], entity);
  }

  return out;
}

/**
 * Extract the entity name from an ActiveModel path. Examples:
 *   `UserActiveModel`               → `User`
 *   `user_entity::ActiveModel`      → `User` (via stem capitalize)
 *   `crate::entities::ActiveModel`  → `Entities` (last-module stem
 *      capitalized — caller falls back to project map for the alias)
 */
function entityFromActiveModelPath(text: string): string | null {
  const last = lastPathSegment(text);
  if (last === 'ActiveModel') {
    // Look at the module segment immediately before
    // `::ActiveModel`. `user_entity::ActiveModel` → 'user_entity'.
    const before = text.slice(0, text.length - last.length - 2);
    const mod = lastPathSegment(before);
    if (mod && mod.length > 0) {
      // Capitalize the first letter as a heuristic. Project map
      // typically has the alias (`User`) — caller can also fall
      // back via stripActiveModelSuffix.
      return mod.charAt(0).toUpperCase() + mod.slice(1).replace(/_entity$/, '');
    }
    return null;
  }
  const m = /^([A-Z]\w*?)ActiveModel$/.exec(last);
  return m ? m[1] : null;
}

/**
 * `UserActiveModel` → `User`. Strips the `ActiveModel` suffix when
 * present at the end of the type name. Returns null if the receiver
 * is just a variable name (no PascalCase ActiveModel reference).
 */
function stripActiveModelSuffix(text: string): string | null {
  // PascalCase type — `XxxActiveModel` at the tail. Take the
  // last `::`-separated segment first (e.g. `user::ActiveModel` →
  // `ActiveModel`).
  const last = lastPathSegment(text);
  const m = /^([A-Z]\w*?)ActiveModel$/.exec(last);
  if (m) return m[1];
  // `ActiveModel` alone — can't recover the entity name.
  if (last === 'ActiveModel') return null;
  return null;
}

function pluralize(name: string): string {
  // Conservative pluralization for common English nouns.
  if (/(s|sh|ch|x|z)$/.test(name)) return name + 'es';
  if (/[^aeiou]y$/.test(name)) return name.slice(0, -1) + 'ies';
  return name + 's';
}

function lastPathSegment(text: string): string {
  const i = text.lastIndexOf('::');
  return i >= 0 ? text.slice(i + 2) : text;
}

/**
 * Scan top-level items for `#[sea_orm(table_name = "X")]` attributes
 * sitting just above a struct named `Entity` or `Model`. Returns a
 * map of `<owner-struct-name> → table_name`.
 *
 * The typical SeaORM-generated layout is:
 *
 *   mod user {
 *       #[derive(DeriveEntityModel)]
 *       #[sea_orm(table_name = "users")]
 *       pub struct Model { ... }
 *
 *       pub struct Entity;
 *   }
 *
 * For v1 we look for the attribute anywhere in the file and key the
 * result under `'Entity'`. Callers fall back to snake_case the
 * entity label if the map misses.
 */
function scanModuleForTableNames(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'attribute_item') {
      const m = n.text.match(/sea_orm\s*\(\s*table_name\s*=\s*"([^"]+)"\s*\)/);
      if (m) {
        // Store under the magic key 'Entity'; visitor consults this
        // as a fallback when the call-site entity label misses.
        out.set('Entity', m[1]);
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(rootNode);
  return out;
}

function toSnakeCase(name: string): string {
  // `User` → `user`, `OrderItem` → `order_item`.
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}
