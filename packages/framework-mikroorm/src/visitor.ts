import { Node, type ClassDeclaration } from 'ts-morph';
import {
  idFor,
  type DatabaseColumn,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@adorable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@adorable/lang-ts';

/**
 * MikroORM visitor (#372). Structure mirrors framework-typeorm but
 * with MikroORM's distinct decorator names and repository type:
 *
 *   @Entity({ tableName: 'users' })  / @Entity()
 *   @PrimaryKey()                    / @Property()
 *   EntityRepository<User>           / EntityManager
 *   em.find(EntityClass, ...)        — first-arg-is-entity
 */

const READ_METHODS: ReadonlySet<string> = new Set([
  'find', 'findOne', 'findOneOrFail', 'findAndCount',
  'count', 'getReference', 'qb', 'createQueryBuilder',
]);
const WRITE_METHODS: ReadonlySet<string> = new Set([
  'persist', 'persistAndFlush', 'insert', 'create', 'upsert',
]);
const UPDATE_METHODS: ReadonlySet<string> = new Set([
  'flush', 'nativeUpdate',
]);
const DELETE_METHODS: ReadonlySet<string> = new Set([
  'remove', 'removeAndFlush', 'nativeDelete',
]);

const REPO_TYPE_NAMES: ReadonlySet<string> = new Set([
  'EntityRepository',
  'MongoEntityRepository',
  'SqlEntityRepository',
]);

const ENTITY_MANAGER_TYPES: ReadonlySet<string> = new Set([
  'EntityManager',
  'MikroORM',
]);

const COLUMN_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'Property',
  'PrimaryKey',
  'SerializedPrimaryKey',
  'Enum',
  'Formula',
]);

const REPO_SUFFIX_PATTERN = /(?:Repo(?:sitory)?|repo(?:sitory)?)$/;

export function createMikroOrmVisitor(systemId: string): TsFrameworkVisitor {
  const emittedTables = new Set<string>();
  const emittedColumns = new Set<string>();

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
      if (Node.isClassDeclaration(node)) {
        handleEntityClass(node, ctx, systemId, ensureTable, emittedColumns);
        return;
      }
      // #383 — EntitySchema builder: `new EntitySchema({ name, tableName, properties })`.
      // Medusa v1 and any MikroORM codebase that prefers the
      // schema-builder API over decorators land here.
      if (Node.isNewExpression(node)) {
        handleEntitySchema(node, ctx, ensureTable, emittedColumns);
        return;
      }
      if (!Node.isCallExpression(node)) return;
      // #383 — Medusa v2 `model.define('name', { ... })`. Discovered
      // before falling through to the DBI / method-call path so the
      // table emits even though `define` isn't a CRUD method.
      if (handleModelDefine(node, ctx, ensureTable, emittedColumns)) return;
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

      const receiver = callee.getExpression();
      const resolved = resolveReceiverTable(receiver, node);
      if (!resolved) return;

      const tableId = ensureTable(ctx, resolved.tableName, null);

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: tableId,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'mikroorm',
        rawQuery: null,
        confidence: resolved.confidence,
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

// ──────────────────────────────────────────────────────────────────────
// Entity discovery
// ──────────────────────────────────────────────────────────────────────

function handleEntityClass(
  cls: ClassDeclaration,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  systemId: string,
  ensureTable: (
    ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
    tableName: string,
    declaredIn: string | null,
  ) => string,
  emittedColumns: Set<string>,
): void {
  const dec = cls.getDecorator('Entity');
  if (!dec) return;
  const className = cls.getName();
  if (!className) return;
  const tableName = readEntityTableName(dec, className);
  const tableId = ensureTable(ctx, tableName, ctx.sourceFile.filePath);
  for (const member of cls.getProperties()) {
    const colDecorator = getColumnDecorator(member);
    if (!colDecorator) continue;
    const propName = member.getName();
    const columnId = idFor.databaseColumn({ tableId, name: propName });
    if (emittedColumns.has(columnId)) continue;
    emittedColumns.add(columnId);
    const isPrimaryKey = colDecorator === 'PrimaryKey' || colDecorator === 'SerializedPrimaryKey';
    const column: DatabaseColumn = {
      nodeType: 'DatabaseColumn',
      id: columnId,
      tableId,
      name: propName,
      type: member.getTypeNode()?.getText() ?? null,
      nullable: member.hasQuestionToken(),
      isPrimaryKey,
      isForeignKey: false,
    };
    ctx.emitNode(column);
    ctx.emitEdge({ edgeType: 'COLUMN_IN', from: columnId, to: tableId });
  }
  void systemId;
}

// ──────────────────────────────────────────────────────────────────────
// EntitySchema discovery (#383) — `new EntitySchema({ name, tableName, properties })`
// ──────────────────────────────────────────────────────────────────────

function handleEntitySchema(
  node: import('ts-morph').NewExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  ensureTable: (
    ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
    tableName: string,
    declaredIn: string | null,
  ) => string,
  emittedColumns: Set<string>,
): void {
  const ctor = node.getExpression();
  if (!Node.isIdentifier(ctor) || ctor.getText() !== 'EntitySchema') return;
  const args = node.getArguments();
  if (args.length === 0) return;
  const config = args[0];
  if (!Node.isObjectLiteralExpression(config)) return;

  const tableName = readStringProp(config, 'tableName') ?? readStringProp(config, 'name');
  if (!tableName) return;
  const tableId = ensureTable(ctx, tableName, ctx.sourceFile.filePath);
  emitColumnsFromPropertyMap(config, 'properties', tableId, ctx, emittedColumns);
}

// ──────────────────────────────────────────────────────────────────────
// model.define discovery (#383) — Medusa v2 pattern
// ──────────────────────────────────────────────────────────────────────

function handleModelDefine(
  node: import('ts-morph').CallExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  ensureTable: (
    ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
    tableName: string,
    declaredIn: string | null,
  ) => string,
  emittedColumns: Set<string>,
): boolean {
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (callee.getNameNode().getText() !== 'define') return false;
  const receiver = callee.getExpression();
  if (!Node.isIdentifier(receiver) || receiver.getText() !== 'model') return false;

  const args = node.getArguments();
  if (args.length === 0) return false;
  const first = args[0];
  if (!Node.isStringLiteral(first) && !Node.isNoSubstitutionTemplateLiteral(first)) return false;
  const tableName = first.getLiteralValue();
  if (!tableName) return false;
  const tableId = ensureTable(ctx, tableName, ctx.sourceFile.filePath);
  // Properties: second arg, an object literal where each property
  // value is a fluent chain rooted at `model.<type>(...)` (model.text(),
  // model.id(), model.number(), ...) with optional modifiers like
  // .primaryKey() / .nullable() / .unique() / .searchable() (#396).
  if (args.length >= 2 && Node.isObjectLiteralExpression(args[1])) {
    for (const prop of args[1].getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const propName = prop.getName();
      if (!propName) continue;
      const meta = extractModelDefineColumnMeta(prop.getInitializer());
      emitColumn(ctx, tableId, propName, meta.type, meta.nullable, meta.isPrimaryKey, emittedColumns);
    }
  }
  return true;
}

/**
 * Walk a Medusa v2 `model.<type>(...).modifier()....modifier()` chain
 * (#396). The head call's method name is the column type
 * (`id`/`text`/`number`/`date`/`json`/`boolean`/`enum`...); each tail
 * `.method()` is a modifier we may care about:
 *   - .primaryKey() → isPrimaryKey
 *   - .nullable()   → nullable
 *   - .unique() / .searchable() / .index() — recognised but no
 *     schema field to record (we just don't bail).
 *
 * Returns sensible defaults when the value isn't a model.* chain.
 */
function extractModelDefineColumnMeta(
  init: Node | undefined,
): { type: string | null; nullable: boolean; isPrimaryKey: boolean } {
  const result = { type: null as string | null, nullable: false, isPrimaryKey: false };
  if (!init) return result;

  let current: Node | null = init;
  // Walk outermost-to-innermost: each iteration peels one
  // .method(...) layer off the call chain. We stop when we find a
  // PropertyAccessExpression rooted at `model.<type>`.
  while (current) {
    if (!Node.isCallExpression(current)) return result;
    const callee = current.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return result;
    const methodName = callee.getNameNode().getText();
    const receiver = callee.getExpression();
    if (Node.isIdentifier(receiver) && receiver.getText() === 'model') {
      // Head reached: receiver is `model`, methodName is the type.
      result.type = methodName;
      return result;
    }
    // Modifier in the tail chain.
    if (methodName === 'primaryKey') result.isPrimaryKey = true;
    else if (methodName === 'nullable') result.nullable = true;
    // `.unique()` / `.searchable()` / `.index()` etc — recognise but
    // ignore; no schema field to record.
    current = receiver;
  }
  return result;
}

function readStringProp(obj: import('ts-morph').ObjectLiteralExpression, key: string): string | null {
  const p = obj.getProperty(key);
  if (!p || !Node.isPropertyAssignment(p)) return null;
  const init = p.getInitializer();
  if (!init) return null;
  if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) {
    return init.getLiteralValue();
  }
  return null;
}

function emitColumnsFromPropertyMap(
  config: import('ts-morph').ObjectLiteralExpression,
  key: string,
  tableId: string,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  emittedColumns: Set<string>,
): void {
  const propsProp = config.getProperty(key);
  if (!propsProp || !Node.isPropertyAssignment(propsProp)) return;
  const init = propsProp.getInitializer();
  if (!init || !Node.isObjectLiteralExpression(init)) return;
  for (const prop of init.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const propName = prop.getName();
    if (!propName) continue;
    // Property values are typically object literals (`{ type: 'string', primary: true }`)
    // or method-call shapes. Try to extract `primary`, `nullable`, and `type`.
    let isPrimary = false;
    let nullable = false;
    let typeText: string | null = null;
    const propInit = prop.getInitializer();
    if (propInit && Node.isObjectLiteralExpression(propInit)) {
      const primaryProp = propInit.getProperty('primary');
      if (primaryProp && Node.isPropertyAssignment(primaryProp)) {
        const v = primaryProp.getInitializer();
        if (v && v.getText() === 'true') isPrimary = true;
      }
      const nullableProp = propInit.getProperty('nullable');
      if (nullableProp && Node.isPropertyAssignment(nullableProp)) {
        const v = nullableProp.getInitializer();
        if (v && v.getText() === 'true') nullable = true;
      }
      const typeProp = propInit.getProperty('type');
      if (typeProp && Node.isPropertyAssignment(typeProp)) {
        const v = typeProp.getInitializer();
        if (v && (Node.isStringLiteral(v) || Node.isNoSubstitutionTemplateLiteral(v))) {
          typeText = v.getLiteralValue();
        }
      }
    }
    emitColumn(ctx, tableId, propName, typeText, nullable, isPrimary, emittedColumns);
  }
}

function emitColumn(
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  tableId: string,
  name: string,
  type: string | null,
  nullable: boolean,
  isPrimaryKey: boolean,
  emittedColumns: Set<string>,
): void {
  const columnId = idFor.databaseColumn({ tableId, name });
  if (emittedColumns.has(columnId)) return;
  emittedColumns.add(columnId);
  const column: DatabaseColumn = {
    nodeType: 'DatabaseColumn',
    id: columnId,
    tableId,
    name,
    type,
    nullable,
    isPrimaryKey,
    isForeignKey: false,
  };
  ctx.emitNode(column);
  ctx.emitEdge({ edgeType: 'COLUMN_IN', from: columnId, to: tableId });
}

function getColumnDecorator(member: ReturnType<ClassDeclaration['getProperties']>[number]): string | null {
  for (const dec of member.getDecorators()) {
    if (COLUMN_DECORATOR_NAMES.has(dec.getName())) return dec.getName();
  }
  return null;
}

function readEntityTableName(
  decorator: ReturnType<ClassDeclaration['getDecorator']>,
  className: string,
): string {
  if (!decorator) return classNameToTable(className);
  const args = decorator.getArguments();
  if (args.length === 0) return classNameToTable(className);
  const first = args[0];
  if (Node.isObjectLiteralExpression(first)) {
    const tableNameProp = first.getProperty('tableName');
    if (tableNameProp && Node.isPropertyAssignment(tableNameProp)) {
      const init = tableNameProp.getInitializer();
      if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
        return init.getLiteralValue();
      }
    }
  }
  return classNameToTable(className);
}

function classNameToTable(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

// ──────────────────────────────────────────────────────────────────────
// Receiver resolution
// ──────────────────────────────────────────────────────────────────────

interface ResolvedReceiver {
  tableName: string;
  confidence: 'direct' | 'inferred';
}

function resolveReceiverTable(receiver: Node, callNode: Node): ResolvedReceiver | null {
  if (Node.isPropertyAccessExpression(receiver) && Node.isThisExpression(receiver.getExpression())) {
    const fieldName = receiver.getNameNode().getText();
    const cls = receiver.getFirstAncestor(
      (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
    );
    if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
      const resolved = findEntityTypeArgOnClassMember(cls, fieldName);
      if (resolved) {
        if (resolved === '__entity_manager__') {
          if (Node.isCallExpression(callNode)) {
            const args = callNode.getArguments();
            if (args.length > 0) {
              const tableName = resolveEntityTableNameFromIdentifier(args[0])
                ?? (Node.isIdentifier(args[0]) ? classNameToTable(args[0].getText()) : null);
              if (tableName) return { tableName, confidence: 'direct' };
            }
          }
        } else {
          return { tableName: resolved, confidence: 'direct' };
        }
      }
    }
  }
  const receiverText = receiver.getText();
  if (!isMikroReceiver(receiverText)) return null;
  const tableName = inferTableNameFromReceiver(receiverText);
  if (!tableName) return null;
  return { tableName, confidence: 'inferred' };
}

function findEntityTypeArgOnClassMember(
  cls: import('ts-morph').ClassDeclaration | import('ts-morph').ClassExpression,
  fieldName: string,
): string | null {
  for (const prop of cls.getProperties()) {
    if (prop.getName() !== fieldName) continue;
    return readEntityFromTypeNode(prop.getTypeNode());
  }
  const ctor = cls.getConstructors()[0];
  if (ctor) {
    for (const param of ctor.getParameters()) {
      if (param.getName() !== fieldName) continue;
      return readEntityFromTypeNode(param.getTypeNode());
    }
  }
  return null;
}

function readEntityFromTypeNode(typeNode: Node | undefined): string | null {
  if (!typeNode) return null;
  if (!Node.isTypeReference(typeNode)) return null;
  const name = typeNode.getTypeName();
  if (!Node.isIdentifier(name)) return null;
  const typeName = name.getText();
  if (REPO_TYPE_NAMES.has(typeName)) {
    const args = typeNode.getTypeArguments();
    if (args.length === 0) return null;
    const arg = args[0];
    if (!Node.isTypeReference(arg)) return null;
    const argName = arg.getTypeName();
    if (!Node.isIdentifier(argName)) return null;
    const tableName = resolveEntityTableNameFromIdentifier(argName);
    return tableName ?? argName.getText();
  }
  if (ENTITY_MANAGER_TYPES.has(typeName)) return '__entity_manager__';
  return null;
}

function resolveEntityTableNameFromIdentifier(ident: Node): string | null {
  if (!Node.isIdentifier(ident)) return null;
  const sym = ident.getSymbol();
  if (!sym) return null;
  for (const d of sym.getDeclarations()) {
    const cls = resolveToClassDeclaration(d);
    if (!cls) continue;
    const dec = cls.getDecorator('Entity');
    if (!dec) continue;
    const className = cls.getName?.() ?? ident.getText();
    return readEntityTableName(dec, className ?? ident.getText());
  }
  return null;
}

function resolveToClassDeclaration(d: Node): import('ts-morph').ClassDeclaration | null {
  if (Node.isClassDeclaration(d)) return d;
  if (Node.isImportSpecifier(d) || Node.isImportClause(d) || Node.isNamespaceImport(d)) {
    const impDecl = d.getFirstAncestor((a) => Node.isImportDeclaration(a));
    if (!impDecl || !Node.isImportDeclaration(impDecl)) return null;
    const target = impDecl.getModuleSpecifierSourceFile();
    if (!target) return null;
    const exportName = Node.isImportSpecifier(d)
      ? d.getName()
      : Node.isImportClause(d)
      ? 'default'
      : null;
    if (!exportName) return null;
    const exported = target.getExportedDeclarations().get(exportName);
    if (!exported) return null;
    for (const e of exported) {
      if (Node.isClassDeclaration(e)) return e;
    }
  }
  return null;
}

function isMikroReceiver(text: string): boolean {
  const isThis = text.startsWith('this.');
  const name = isThis ? text.slice(5) : text;
  if (name === 'em' || name === 'orm' || name === 'repository') return true;
  if (!REPO_SUFFIX_PATTERN.test(name)) return false;
  if (!isThis && !name.endsWith('Repository')) return false;
  return true;
}

function inferTableNameFromReceiver(receiverText: string): string | null {
  let name = receiverText.startsWith('this.') ? receiverText.slice(5) : receiverText;
  name = name.replace(REPO_SUFFIX_PATTERN, '');
  if (!name || name === 'em' || name === 'orm' || name === 'repository') return null;
  return name.charAt(0).toLowerCase() + name.slice(1);
}
