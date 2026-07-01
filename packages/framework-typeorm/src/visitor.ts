import { Node, type ClassDeclaration } from 'ts-morph';
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseTable,
  type DatabaseColumn,
  type DatabaseOperation,
} from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@veoable/lang-ts';

/**
 * TypeORM framework visitor (#41, expanded #366).
 *
 * Two extraction surfaces:
 *
 * 1. **Entity discovery** — classes decorated with `@Entity()` emit
 *    `DatabaseTable` + `DatabaseColumn` nodes. Receiver chain calls
 *    on a `Repository<EntityClass>` can then attribute to the
 *    extracted table.
 *
 * 2. **Receiver detection** — three modes for resolving the table
 *    targeted by a CRUD call:
 *
 *      a. Field type `Repository<X>` / `EntityRepository<X>` →
 *         resolves to entity `X` at `'direct'` confidence (the
 *         NestJS DI pattern with `@InjectRepository(X)`).
 *      b. `<receiver>.find()` where `<receiver>` is an EntityManager
 *         and the first arg is an entity class → entity class
 *         identifies the table at `'direct'` confidence.
 *      c. Name-heuristic fallback — `this.usersRepo.find()` /
 *         `userRepository.find()` strip `Repo`/`Repository` suffix
 *         and emit at `'inferred'` confidence (legacy behavior).
 */

const READ_METHODS: ReadonlySet<string> = new Set([
  'find', 'findOne', 'findOneBy', 'findOneOrFail', 'findOneByOrFail',
  'findBy', 'findAndCount', 'findAndCountBy',
  'count', 'countBy', 'sum', 'average', 'minimum', 'maximum',
  'exist', 'existsBy',
  'query', 'createQueryBuilder',
]);

const WRITE_METHODS: ReadonlySet<string> = new Set([
  'save', 'insert', 'create', 'upsert',
]);

const UPDATE_METHODS: ReadonlySet<string> = new Set([
  'update', 'increment', 'decrement', 'merge',
]);

const DELETE_METHODS: ReadonlySet<string> = new Set([
  'delete', 'remove', 'softDelete', 'softRemove', 'restore',
]);

const REPO_SUFFIX_PATTERN = /(?:Repo(?:sitory)?|repo(?:sitory)?)$/;

/** Type names that wrap an entity class as a single type argument. */
const REPO_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Repository',
  'EntityRepository',
  'TreeRepository',
  'MongoRepository',
]);

const ENTITY_MANAGER_TYPES: ReadonlySet<string> = new Set([
  'EntityManager',
  'DataSource',
]);

export function createTypeormVisitor(systemId: string): TsFrameworkVisitor {
  const emittedTables = new Set<string>();
  const emittedColumns = new Set<string>();
  // #384 — alias map populated as entity classes are discovered. Maps
  // {lowercaseFirstChar(ClassName), ClassName} → canonical table name
  // (the `@Entity('snake_case')` arg if present, else class name with
  // first char lowercased). The inferred-receiver fallback consults this
  // before emitting a fresh table node so that `this.userRepository.find()`
  // routes to the same `users` table as `Repository<User>` does.
  const classNameAliases = new Map<string, string>();
  const recordAlias = (className: string, canonicalName: string): void => {
    classNameAliases.set(className, canonicalName);
    classNameAliases.set(className.charAt(0).toLowerCase() + className.slice(1), canonicalName);
  };

  const emitTable = (
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
      // #366 — @Entity-decorated classes → DatabaseTable + DatabaseColumn.
      if (Node.isClassDeclaration(node)) {
        handleEntityClass(node, ctx, systemId, emitTable, emittedColumns, recordAlias);
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

      const receiver = callee.getExpression();
      const resolved = resolveReceiverTable(receiver, node, methodName, classNameAliases);
      if (!resolved) return;
      const { tableName, confidence } = resolved;

      const tableId = emitTable(ctx, tableName, null);

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: tableId,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'typeorm',
        rawQuery: null,
        confidence,
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
// Entity discovery (#366)
// ──────────────────────────────────────────────────────────────────────

function handleEntityClass(
  cls: ClassDeclaration,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  systemId: string,
  emitTable: (
    ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
    tableName: string,
    declaredIn: string | null,
  ) => string,
  emittedColumns: Set<string>,
  recordAlias: (className: string, canonicalName: string) => void,
): void {
  const entityDecorator = cls.getDecorator('Entity');
  if (!entityDecorator) return;
  const className = cls.getName();
  if (!className) return;
  // Table name: explicit string arg or first option `name` if object,
  // otherwise lowercase class name.
  const tableName = readEntityTableName(entityDecorator, className);
  const tableId = emitTable(ctx, tableName, ctx.sourceFile.filePath);
  // #384 — record both the PascalCase class name and the receiver-naming
  // convention (lowercase first char) as aliases of the canonical table.
  // Used by the inferred-fallback path to skip emitting a duplicate node
  // when a service references the entity by name only (e.g.
  // `this.appVersionRepository.find()` for `class AppVersion`).
  recordAlias(className, tableName);

  // Columns: @Column, @PrimaryColumn, @PrimaryGeneratedColumn, @CreateDateColumn, @UpdateDateColumn.
  for (const member of cls.getProperties()) {
    const colDecorator = getColumnDecorator(member);
    if (!colDecorator) continue;
    const propName = member.getName();
    const columnId = idFor.databaseColumn({ tableId, name: propName });
    if (emittedColumns.has(columnId)) continue;
    emittedColumns.add(columnId);
    const isPrimaryKey =
      colDecorator === 'PrimaryColumn' ||
      colDecorator === 'PrimaryGeneratedColumn' ||
      colDecorator === 'ObjectIdColumn';
    const typeAnnotation = member.getTypeNode()?.getText() ?? null;
    const column: DatabaseColumn = {
      nodeType: 'DatabaseColumn',
      id: columnId,
      tableId,
      name: propName,
      type: typeAnnotation,
      nullable: member.hasQuestionToken(),
      isPrimaryKey,
      isForeignKey: false,
    };
    ctx.emitNode(column);
    ctx.emitEdge({ edgeType: 'COLUMN_IN', from: columnId, to: tableId });
  }
  void systemId;
}

const COLUMN_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
  'ObjectIdColumn',
]);

function getColumnDecorator(member: ReturnType<ClassDeclaration['getProperties']>[number]): string | null {
  for (const dec of member.getDecorators()) {
    const name = dec.getName();
    if (COLUMN_DECORATOR_NAMES.has(name)) return name;
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
  // `@Entity('table_name')`
  if (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) {
    return first.getLiteralValue();
  }
  // `@Entity({ name: 'table_name', ... })`
  if (Node.isObjectLiteralExpression(first)) {
    const nameProp = first.getProperty('name');
    if (nameProp && Node.isPropertyAssignment(nameProp)) {
      const init = nameProp.getInitializer();
      if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
        return init.getLiteralValue();
      }
    }
  }
  // `@Entity('table_name', { ... })`
  if (args.length >= 2 && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first))) {
    return first.getLiteralValue();
  }
  return classNameToTable(className);
}

function classNameToTable(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

// ──────────────────────────────────────────────────────────────────────
// Receiver → table resolution
// ──────────────────────────────────────────────────────────────────────

interface ResolvedReceiver {
  tableName: string;
  confidence: 'direct' | 'inferred';
}

function resolveReceiverTable(
  receiver: Node,
  callNode: Node,
  methodName: string,
  classNameAliases: ReadonlyMap<string, string>,
): ResolvedReceiver | null {
  // #366 — `this.<field>` typed as `Repository<X>` / `EntityRepository<X>`.
  if (Node.isPropertyAccessExpression(receiver) && Node.isThisExpression(receiver.getExpression())) {
    const fieldName = receiver.getNameNode().getText();
    const cls = receiver.getFirstAncestor(
      (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
    );
    if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
      // Look for the class member or parameter property by name.
      const resolved = findEntityTypeArgOnClassMember(cls, fieldName);
      if (resolved) {
        // #366 — EntityManager pattern: `this.em.find(EntityClass, ...)`
        // where the first arg is the entity. If the field type is
        // EntityManager / DataSource, extract the first arg as the
        // target table.
        if (resolved === '__entity_manager__') {
          const entityFromArg = extractEntityArg(callNode);
          if (entityFromArg) {
            // Resolve the arg identifier through its @Entity decorator
            // so EntityManager.find(User) routes to the same table id
            // as `Repository<User>` does.
            const callArgs = (callNode as import('ts-morph').CallExpression).getArguments();
            const tableName = resolveEntityTableNameFromIdentifier(callArgs[0])
              ?? classNameToTable(entityFromArg);
            return { tableName, confidence: 'direct' };
          }
        } else {
          // `resolved` is already the canonical table name from
          // `@Entity(...)` (or the class name when no arg present).
          // Don't lowercase again — that would mis-route
          // `@Entity('Users')` to `users`.
          return { tableName: resolved, confidence: 'direct' };
        }
      }
    }
  }

  // Fallback — name-heuristic. Preserve the legacy behavior so plain
  // `userRepository.find(...)` still emits, just at `'inferred'`.
  const receiverText = receiver.getText();
  if (!isTypeormReceiver(receiverText)) return null;
  const tableName = inferTableNameFromReceiver(receiverText, methodName, callNode);
  if (!tableName) return null;
  // #384 — redirect to the canonical table name when the entity was
  // already discovered with an `@Entity('snake')` arg whose camelCase
  // class name matches our inferred receiver-stem. Drops duplicate
  // tables like `appVersion` when `app_versions` already exists.
  const canonical = classNameAliases.get(tableName);
  return { tableName: canonical ?? tableName, confidence: 'inferred' };
}

/**
 * Find the class member (property or parameter-property) named `fieldName`
 * and return the entity name from its `Repository<X>` /
 * `EntityRepository<X>` type annotation. Returns `'__entity_manager__'`
 * when the field is a bare EntityManager / DataSource.
 */
function findEntityTypeArgOnClassMember(
  cls: import('ts-morph').ClassDeclaration | import('ts-morph').ClassExpression,
  fieldName: string,
): string | null {
  // Property declarations.
  for (const prop of cls.getProperties()) {
    if (prop.getName() !== fieldName) continue;
    return readEntityFromTypeNode(prop.getTypeNode());
  }
  // Constructor parameter properties (NestJS DI).
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
    // #366 — Resolve the entity class identifier to its declaration
    // and use the `@Entity(name)` table name when present, so a
    // receiver `this.userRepo: Repository<User>` and the entity
    // `@Entity('users') class User` route to the SAME table id.
    // #384 — Falls back to lowercase-first-char of class identifier
    // (matching handleEntityClass's no-arg branch) so a `Repository<X>`
    // for a class `X` with no @Entity arg routes to the same `x` table.
    // Never falls through to PascalCase — that was producing
    // duplicate `AppVersion` + `appVersion` table nodes on ToolJet.
    const tableName = resolveEntityTableNameFromIdentifier(argName);
    if (tableName) return tableName;
    const ident = argName.getText();
    return classNameToTable(ident);
  }
  if (ENTITY_MANAGER_TYPES.has(typeName)) {
    return '__entity_manager__';
  }
  return null;
}

/**
 * Given an identifier referencing an entity class, resolve its
 * declaration and read the `@Entity()` decorator's table-name
 * argument. Returns null when the identifier doesn't resolve to a
 * class with an `@Entity` decorator (caller falls back to the
 * identifier text).
 */
function resolveEntityTableNameFromIdentifier(ident: Node): string | null {
  if (!Node.isIdentifier(ident)) return null;
  const sym = ident.getSymbol();
  if (!sym) return null;
  // Follow import specifiers + aliased symbols to the underlying
  // class declaration. ts-morph's `getDeclarations()` on an imported
  // binding returns the ImportSpecifier, not the producer's class
  // — we need to manually thread through the import.
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

function extractEntityArg(callNode: Node): string | null {
  if (!Node.isCallExpression(callNode)) return null;
  const args = callNode.getArguments();
  if (args.length === 0) return null;
  const first = args[0];
  if (!Node.isIdentifier(first)) return null;
  return first.getText();
}

// ──────────────────────────────────────────────────────────────────────
// Legacy name-heuristic fallback
// ──────────────────────────────────────────────────────────────────────

function isTypeormReceiver(text: string): boolean {
  const isThis = text.startsWith('this.');
  const name = isThis ? text.slice(5) : text;
  if (name === 'repository' || name === 'manager') return true;
  if (!REPO_SUFFIX_PATTERN.test(name)) return false;
  if (!isThis && !name.endsWith('Repository')) return false;
  return true;
}

function inferTableNameFromReceiver(
  receiverText: string,
  _methodName: string,
  _callNode: Node,
): string | null {
  let name = receiverText.startsWith('this.') ? receiverText.slice(5) : receiverText;
  name = name.replace(REPO_SUFFIX_PATTERN, '');
  if (!name || name === 'repository' || name === 'manager') return null;
  return name.charAt(0).toLowerCase() + name.slice(1);
}
