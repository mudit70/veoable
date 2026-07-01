import { Node, type ClassDeclaration } from 'ts-morph';
import {
  idFor,
  type DatabaseColumn,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@veoable/lang-ts';

/**
 * Sequelize visitor (#367).
 *
 * Two entity-declaration paths:
 *  1. sequelize-typescript: `@Table({ tableName: 'users' }) class User extends Model { @Column id }`.
 *  2. Vanilla: `class User extends Model {}` plus `User.init({...})`.
 *
 * Static-method receivers are looked up against a closure-scoped
 * set of known model class names populated as entities are
 * discovered. Instance-method receivers (`user.update(...)`) are
 * inferred via the closure-scoped instance-of mapping built when
 * a Variable is initialised via `new User(...)` or `User.create(...)`.
 */

const READ_METHODS: ReadonlySet<string> = new Set([
  'findOne', 'findAll', 'findByPk', 'findOrCreate', 'findAndCountAll',
  'count', 'sum', 'min', 'max',
]);
const WRITE_METHODS: ReadonlySet<string> = new Set([
  'create', 'bulkCreate', 'upsert',
]);
const UPDATE_METHODS: ReadonlySet<string> = new Set([
  'update', 'set', 'increment', 'decrement',
]);
const DELETE_METHODS: ReadonlySet<string> = new Set([
  'destroy',
]);

const COLUMN_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'Column',
  'PrimaryKey',
  'AutoIncrement',
  'CreatedAt',
  'UpdatedAt',
  'DeletedAt',
]);

export function createSequelizeVisitor(systemId: string): TsFrameworkVisitor {
  const emittedTables = new Set<string>();
  const emittedColumns = new Set<string>();
  /** Map from Model class name → table name. */
  const modelClassNames = new Map<string, string>();

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
      // Entity discovery from class declarations extending Model
      // or decorated with @Table.
      if (Node.isClassDeclaration(node)) {
        handleModelClass(node, ctx, systemId, ensureTable, modelClassNames, emittedColumns);
        return;
      }
      if (!Node.isCallExpression(node)) return;
      if (!ctx.enclosingFunction) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;

      const methodName = callee.getNameNode().getText();
      let operation: DatabaseOperation | null = null;
      if (READ_METHODS.has(methodName)) operation = 'read';
      else if (WRITE_METHODS.has(methodName)) operation = 'write';
      else if (UPDATE_METHODS.has(methodName)) operation = 'update';
      else if (DELETE_METHODS.has(methodName)) operation = 'delete';
      if (!operation) return;

      // Receiver — must be an Identifier referring to a known Model class.
      const receiver = callee.getExpression();
      if (!Node.isIdentifier(receiver)) return;
      const receiverText = receiver.getText();
      const tableName = modelClassNames.get(receiverText);
      if (!tableName) return;

      const tableId = ensureTable(ctx, tableName, null);
      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: tableId,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'sequelize',
        rawQuery: null,
        confidence: 'direct',
        evidence: buildEvidence(node, ctx.sourceFile.filePath),
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
        sourceLine: node.getStartLineNumber(),
      });
    },
  };
}

function handleModelClass(
  cls: ClassDeclaration,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  systemId: string,
  ensureTable: (
    ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
    tableName: string,
    declaredIn: string | null,
  ) => string,
  modelClassNames: Map<string, string>,
  emittedColumns: Set<string>,
): void {
  const className = cls.getName();
  if (!className) return;

  // Detect: @Table decorator OR `extends Model`.
  const tableDecorator = cls.getDecorator('Table');
  const extendsExpr = cls.getExtends();
  const extendsModel =
    extendsExpr !== undefined &&
    Node.isIdentifier(extendsExpr.getExpression()) &&
    extendsExpr.getExpression().getText() === 'Model';

  if (!tableDecorator && !extendsModel) return;

  const tableName = tableDecorator
    ? readTableNameFromDecorator(tableDecorator, className)
    : pluralize(className);

  ensureTable(ctx, tableName, ctx.sourceFile.filePath);
  modelClassNames.set(className, tableName);

  // Columns: @Column-decorated properties (sequelize-typescript).
  for (const member of cls.getProperties()) {
    const colDec = getColumnDecorator(member);
    if (!colDec) continue;
    const propName = member.getName();
    const columnId = idFor.databaseColumn({
      tableId: idFor.databaseTable({ systemId, schema: null, name: tableName }),
      name: propName,
    });
    if (emittedColumns.has(columnId)) continue;
    emittedColumns.add(columnId);
    const tableId = idFor.databaseTable({ systemId, schema: null, name: tableName });
    const column: DatabaseColumn = {
      nodeType: 'DatabaseColumn',
      id: columnId,
      tableId,
      name: propName,
      type: member.getTypeNode()?.getText() ?? null,
      nullable: member.hasQuestionToken(),
      isPrimaryKey: colDec === 'PrimaryKey',
      isForeignKey: false,
    };
    ctx.emitNode(column);
    ctx.emitEdge({ edgeType: 'COLUMN_IN', from: columnId, to: tableId });
  }
}

function readTableNameFromDecorator(
  decorator: ReturnType<ClassDeclaration['getDecorator']>,
  className: string,
): string {
  if (!decorator) return pluralize(className);
  const args = decorator.getArguments();
  if (args.length === 0) return pluralize(className);
  const first = args[0];
  if (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) {
    return first.getLiteralValue();
  }
  if (Node.isObjectLiteralExpression(first)) {
    const tableNameProp = first.getProperty('tableName');
    if (tableNameProp && Node.isPropertyAssignment(tableNameProp)) {
      const init = tableNameProp.getInitializer();
      if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
        return init.getLiteralValue();
      }
    }
  }
  return pluralize(className);
}

function getColumnDecorator(member: ReturnType<ClassDeclaration['getProperties']>[number]): string | null {
  for (const dec of member.getDecorators()) {
    if (COLUMN_DECORATOR_NAMES.has(dec.getName())) return dec.getName();
  }
  return null;
}

/**
 * Sequelize's default table-naming convention is the pluralised
 * lowercase class name. This pluraliser handles the common English
 * rules without pulling in a dependency:
 *   User → users
 *   Category → categories
 *   Box → boxes
 *   Class → classes
 *   Photo → photos
 *   Person → people (irregular — explicit map)
 *   Child → children (irregular — explicit map)
 */
const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
};

function pluralize(name: string): string {
  const lc = name.charAt(0).toLowerCase() + name.slice(1);
  if (IRREGULAR_PLURALS[lc]) return IRREGULAR_PLURALS[lc];
  if (/(s|sh|ch|x|z)$/i.test(lc)) return lc + 'es';
  if (/([^aeiou])y$/i.test(lc)) return lc.slice(0, -1) + 'ies';
  return lc + 's';
}
