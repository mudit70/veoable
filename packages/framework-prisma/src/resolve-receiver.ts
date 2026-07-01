import { Node, type Expression } from 'ts-morph';

/**
 * Receiver classification for a Prisma client call.
 *
 * `'client'` — the receiver expression is bound (transitively) to a
 *              `new PrismaClient()` construction. The variable name
 *              is irrelevant: `database`, `orm`, `prismaClient`,
 *              `myPrisma` all resolve as `'client'` if the AST says
 *              they were created by the PrismaClient constructor.
 *
 * `'not-prisma'` — the AST chain successfully resolved the receiver
 *              to a definitively-not-PrismaClient construction (e.g.
 *              `new MongoClient()`). Callers should NOT fall back
 *              to a name heuristic here — the proof is negative.
 *
 * `'unresolved'` — the AST chain broke before reaching a definitive
 *              answer: path-aliased import the type-checker can't
 *              follow, function parameter, dynamic shape, etc.
 *              Callers MAY fall back to a name heuristic.
 */
export type PrismaReceiverKind = 'client' | 'not-prisma' | 'unresolved';

/**
 * #322 — Notable resolver paths the caller may want to track in
 * telemetry. Recorded by the resolver when it takes a path; callers
 * can decide whether to emit a `ConfidenceDecision` span event based
 * on these. We only record paths that are interesting for
 * observability (HOF unwrap, free-function factory, type-annotation
 * walk) — the straightforward `new PrismaClient()` path is not
 * traced because it's the boring majority.
 */
export type ResolverTrace =
  | 'hof-wrapper'        // remember(() => new PrismaClient())
  | 'free-fn-factory'    // prismaClientSingleton() where the fn returns new PrismaClient()
  | 'type-annotation'    // class field's type resolved to a class extending PrismaClient
  | 'param-type'         // function parameter's type annotation resolved to PrismaClient (#307)
  | 'extends-wrapper'    // <recv>.$extends(...) recursed on <recv> (#307)
  | 'returntype-typeof'  // type ExtendedClient = ReturnType<typeof factory> (#307)
  | 'global-default-export'; // global.X assigned to new PrismaClient(), re-exported (#368)

export interface ClassifyOpts {
  /** Optional sink for resolver-path telemetry. */
  onTrace?: (trace: ResolverTrace) => void;
}

/**
 * #6 — AST-based Prisma client detection. Three-valued return so
 * callers can distinguish "AST says it's not Prisma" (negative proof
 * — never fall back) from "AST chain broke before reaching a verdict"
 * (no proof — caller may fall back to a name heuristic).
 *
 * Cases that yield `'client'`:
 *   - `const db = new PrismaClient(); db.user.findMany()`
 *   - `const orm = new PrismaClient()`
 *   - `let database: PrismaClient; database = new PrismaClient()`
 *   - `class S { prisma = new PrismaClient() }` field initializer
 *   - `class S { constructor() { this.client = new PrismaClient() } }`
 *   - `import { PrismaClient } from '@prisma/client'`
 *   - Imported singleton (cross-file): `import { db } from './db'`
 *     where `db` is itself a `new PrismaClient()` in another file.
 *
 * Cases that yield `'not-prisma'`: a `NewExpression` whose
 * constructor identifier is something other than `PrismaClient`,
 * e.g. `new MongoClient()`, `new Map()`.
 *
 * Everything else → `'unresolved'`.
 */
export function classifyPrismaReceiver(
  expr: Expression,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  return classify(expr, new Set<Node>(), opts);
}

function classify(expr: Node, visited: Set<Node>, opts?: ClassifyOpts): PrismaReceiverKind {
  if (visited.has(expr)) return 'unresolved';
  visited.add(expr);

  // The receiver IS itself a `new <X>(...)` expression.
  if (Node.isNewExpression(expr)) {
    return classifyNewExpression(expr);
  }

  // Singleton-with-fallback patterns common in Next.js + Prisma:
  //   const prisma = global.prisma || new PrismaClient();
  //   const prisma = global.prisma ?? new PrismaClient();
  // The `||`/`??` BinaryExpression has two arms; unwrap and try both.
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getText();
    if (op === '||' || op === '??') {
      return mergeKinds([
        classify(expr.getLeft(), visited, opts),
        classify(expr.getRight(), visited, opts),
      ]);
    }
  }

  // Ternary `const prisma = isTest ? mockClient : new PrismaClient()` —
  // try both branches.
  if (Node.isConditionalExpression(expr)) {
    return mergeKinds([
      classify(expr.getWhenTrue(), visited, opts),
      classify(expr.getWhenFalse(), visited, opts),
    ]);
  }

  // Parenthesized expression — unwrap.
  if (Node.isParenthesizedExpression(expr)) {
    return classify(expr.getExpression(), visited, opts);
  }

  // #320 — unwrap transparent operators that don't change the
  // runtime value: type assertions, non-null assertions, await.
  //   const prisma = global.prisma! ?? new PrismaClient();
  //   const prisma = new PrismaClient() as PrismaClient;
  //   () => await getPrisma()
  // Each forwards the inner expression's resolution. Note that
  // `await` only resolves further when the inner expression is
  // itself directly resolvable (an HOF wrapper or a `new`); a free
  // function call (`await getPrismaAsync()`) lands at
  // `'unresolved'` because we don't follow function-return values.
  if (
    Node.isAsExpression(expr) ||
    Node.isTypeAssertion(expr) ||
    Node.isNonNullExpression(expr) ||
    Node.isAwaitExpression(expr)
  ) {
    return classify(expr.getExpression(), visited, opts);
  }

  // #307 — Prisma extension wrapper. Prisma's official extension API:
  //   const extendedPrisma = prisma.$extends(extension);
  //   const extendedPrisma = base.$extends(ext1).$extends(ext2);
  // Returns a client whose `<model>.<op>(...)` accessors behave
  // identically to <recv>. Recursing on <recv> covers arbitrarily
  // long chains because each recursive call peels exactly one
  // `.$extends(...)` layer.
  if (Node.isCallExpression(expr)) {
    const calleeForExtends = expr.getExpression();
    if (Node.isPropertyAccessExpression(calleeForExtends)) {
      const methodName = calleeForExtends.getNameNode().getText();
      if (methodName === '$extends') {
        const kind = classify(calleeForExtends.getExpression(), visited, opts);
        if (kind !== 'unresolved') {
          if (kind === 'client') opts?.onTrace?.('extends-wrapper');
          return kind;
        }
      }
    }
  }

  // #317 — Higher-order singleton wrappers. Documenso's pattern:
  //   const prisma = remember('prisma', () => new PrismaClient());
  //   const db = memoize(() => new PrismaClient());
  // The wrapper takes a callback and returns its memoized result.
  // Recurse on the last argument's body (the factory callback) so
  // the inner `new PrismaClient()` is reachable.
  if (Node.isCallExpression(expr)) {
    const calleeName = hofWrapperName(expr);
    if (calleeName) {
      const args = expr.getArguments();
      if (args.length > 0) {
        const factory = args[args.length - 1];
        if (Node.isArrowFunction(factory) || Node.isFunctionExpression(factory)) {
          const kind = classifyFactoryReturns(factory, visited, opts);
          if (kind === 'client') opts?.onTrace?.('hof-wrapper');
          return kind;
        }
      }
    }

    // #325 — Free-function factory call: `prismaClientSingleton()`
    // where `prismaClientSingleton = () => new PrismaClient(...)`.
    // Common in Next.js + Prisma monorepos (dub, formbricks). We
    // resolve the callee identifier to its function-shaped declaration
    // and classify the return expression(s). `classifyFactoryReturns`
    // (and the inner `classify` calls it makes) handles cycle
    // tracking on body nodes; we don't add the FunctionDeclaration
    // itself to visited so the same factory called from two different
    // chains both resolve.
    const callee = expr.getExpression();
    if (Node.isIdentifier(callee)) {
      const sym = callee.getSymbol();
      if (sym) {
        for (const d of sym.getDeclarations()) {
          if (Node.isFunctionDeclaration(d) && d.hasBody()) {
            const kind = classifyFactoryReturns(d, visited, opts);
            if (kind !== 'unresolved') {
              if (kind === 'client') opts?.onTrace?.('free-fn-factory');
              return kind;
            }
          }
          if (Node.isVariableDeclaration(d)) {
            const init = d.getInitializer();
            if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
              const kind = classifyFactoryReturns(init, visited, opts);
              if (kind !== 'unresolved') {
                if (kind === 'client') opts?.onTrace?.('free-fn-factory');
                return kind;
              }
            }
          }
        }
      }
    }
  }

  // `this.<field>` — trace the class's field declaration or
  // constructor assignment.
  if (Node.isPropertyAccessExpression(expr)) {
    const left = expr.getExpression();
    const fieldName = expr.getNameNode().getText();
    if (Node.isThisExpression(left)) {
      const cls = expr.getFirstAncestor(
        (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
      );
      if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
        return classifyClassField(cls, fieldName, visited, opts);
      }
    }
    // #368 — `global.<field>` / `globalThis.<field>` — the canonical
    // Next.js + Prisma "hot-reload guard" pattern:
    //   if (!global.prisma) global.prisma = new PrismaClient(...);
    //   export default global.prisma;
    // The receiver `global.prisma` has no traceable initializer
    // through ordinary symbol resolution (the type declaration is
    // just `{ prisma?: PrismaClient }`). Scan the enclosing source
    // file for `global.<field> = <rhs>` assignments matching the
    // same property name and merge their classifications.
    if (Node.isIdentifier(left)) {
      const recvName = left.getText();
      if (recvName === 'global' || recvName === 'globalThis') {
        const kind = classifyGlobalPropertyAssignments(expr, fieldName, visited, opts);
        if (kind !== 'unresolved') {
          if (kind === 'client') opts?.onTrace?.('global-default-export');
          return kind;
        }
      }
    }
    // Non-`this` property access falls through and resolves the symbol.
  }

  // Identifier or property access — follow the symbol's declarations.
  if (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr)) {
    const symbol = (expr as Expression & { getSymbol?: () => unknown })
      .getSymbol?.() as { getDeclarations: () => Node[] } | undefined;
    if (!symbol) return 'unresolved';
    return mergeKinds(symbol.getDeclarations().map((d) => classifyDeclaration(d, visited, opts)));
  }

  return 'unresolved';
}

function classifyDeclaration(decl: Node, visited: Set<Node>, opts?: ClassifyOpts): PrismaReceiverKind {
  // ClassDeclaration first — it has its own visited tracking inside
  // `classifyClassDeclaration` to handle extends-chain cycles.
  // Without this early dispatch, both functions add the same node to
  // `visited` and the inner one falsely treats it as a cycle.
  if (Node.isClassDeclaration(decl) || Node.isClassExpression(decl)) {
    return classifyClassDeclaration(decl, visited, opts);
  }
  if (visited.has(decl)) return 'unresolved';
  visited.add(decl);

  // `const x = <init>` — recurse on the initializer.
  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer) {
      const kind = classify(initializer, visited, opts);
      if (kind !== 'unresolved') return kind;
    }
    // Handle reassignments: `let x: PrismaClient; x = new PrismaClient()`.
    return classifyByAssignment(decl, decl.getName(), visited, opts);
  }

  // Class field initializer: `class S { prisma = new PrismaClient() }`.
  if (Node.isPropertyDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer) {
      const kind = classify(initializer, visited, opts);
      if (kind !== 'unresolved') return kind;
    }
    const cls = decl.getFirstAncestor(
      (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
    );
    if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
      return classifyClassField(cls, decl.getName(), visited, opts);
    }
  }

  // #307 — Function parameter receivers (dependency-injection pattern):
  //   function handler(prisma: PrismaClient) { return prisma.user.findMany(); }
  //   function handler(prisma: ExtendedPrismaClient) { ... }
  // Follow the parameter's type annotation. The class-DI case
  // (constructor parameter property with an accessibility modifier)
  // is already handled in `classifyClassField` (#326); this branch
  // covers plain function parameters, where the receiver lands on
  // a ParameterDeclaration during identifier resolution.
  //
  // #388 — `prisma.$transaction(async (tx) => ...)` callback param.
  // Prisma's transactional client is passed positionally — `tx`
  // typically has no explicit type annotation, so classifyByTypeAnnotation
  // bails. Recognise the callback shape and recurse on the outer
  // receiver instead. We deliberately do NOT emit a separate
  // `'param-type'` trace for the tx case; the recursive `classify`
  // call into the outer receiver attaches whatever source trace
  // that receiver carries (`'hof-wrapper'`, `'free-fn-factory'`, or
  // none for a plain `new PrismaClient()`), which is the more
  // informative signal.
  if (Node.isParameterDeclaration(decl)) {
    const txReceiverKind = classifyTransactionCallbackParam(decl, visited, opts);
    if (txReceiverKind !== 'unresolved') return txReceiverKind;
    const kind = classifyByTypeAnnotation(decl, visited, opts);
    if (kind === 'client') opts?.onTrace?.('param-type');
    return kind;
  }

  // #307 — TypeAliasDeclaration reached via a cross-file
  // `import type { ExtendedPrismaClient } from '...'`. The imported
  // symbol's exported declarations include the type alias; without
  // this branch the type-only import landed at 'unresolved' even
  // though `classifyByTypeAnnotation` could follow it. Forwards to
  // `classifyTypeNode` so the alias's right-hand side (including
  // `ReturnType<typeof X>`) gets the same treatment as in-file
  // aliases.
  if (Node.isTypeAliasDeclaration(decl)) {
    const aliasTypeNode = decl.getTypeNode();
    if (aliasTypeNode) {
      const kind = classifyTypeNode(aliasTypeNode, visited, opts);
      if (kind !== 'unresolved') return kind;
    }
    return 'unresolved';
  }

  // Imported binding — follow to the exported declaration in the
  // target module.
  if (
    Node.isImportSpecifier(decl) ||
    Node.isImportClause(decl) ||
    Node.isNamespaceImport(decl)
  ) {
    return classifyImportedBinding(decl, visited, opts);
  }

  // #368 — `export default <expression>` where <expression> is a
  // PropertyAccessExpression on a global identifier. Cross-file
  // default imports hit this branch when the importer's symbol
  // resolution lands on the ExportAssignment node.
  if (Node.isExportAssignment(decl)) {
    const exprNode = decl.getExpression();
    if (exprNode) {
      const kind = classify(exprNode, visited, opts);
      if (kind !== 'unresolved') return kind;
    }
    return 'unresolved';
  }

  return 'unresolved';
}

function classifyClassField(
  cls: Node,
  fieldName: string,
  visited: Set<Node>,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  if (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) {
    for (const member of cls.getMembers()) {
      if (Node.isPropertyDeclaration(member) && member.getName() === fieldName) {
        const initializer = member.getInitializer();
        if (initializer) {
          const kind = classify(initializer, visited, opts);
          if (kind !== 'unresolved') return kind;
        }
      }
    }
    for (const member of cls.getMembers()) {
      if (
        Node.isConstructorDeclaration(member) ||
        Node.isMethodDeclaration(member)
      ) {
        const body = member.getBody();
        if (!body) continue;
        const kind = scanAssignmentsForField(body, fieldName, visited, opts);
        if (kind !== 'unresolved') return kind;
      }
    }
    // #326 — Type-annotation fallback for the NestJS DI pattern:
    //   constructor(private readonly prismaService: PrismaService) {}
    //   ...this.prismaService.user.findMany()
    // No initializer, no assignment — but the field's type is
    // PrismaService, a class that extends PrismaClient. Same
    // applies to plain typed fields (`private readonly prisma: PrismaService;`)
    // when the value is wired via DI rather than direct construction.
    for (const member of cls.getMembers()) {
      if (Node.isPropertyDeclaration(member) && member.getName() === fieldName) {
        const kind = classifyByTypeAnnotation(member, visited, opts);
        if (kind !== 'unresolved') {
          if (kind === 'client') opts?.onTrace?.('type-annotation');
          return kind;
        }
      }
      if (Node.isConstructorDeclaration(member)) {
        for (const param of member.getParameters()) {
          if (param.getName() !== fieldName) continue;
          // Parameter property only when there's an accessibility
          // modifier (`private`/`public`/`protected`) or `readonly`.
          if (!isParameterProperty(param)) continue;
          const kind = classifyByTypeAnnotation(param, visited, opts);
          if (kind !== 'unresolved') {
            if (kind === 'client') opts?.onTrace?.('type-annotation');
            return kind;
          }
        }
      }
    }
  }
  return 'unresolved';
}

function isParameterProperty(param: Node): boolean {
  if (!Node.isParameterDeclaration(param)) return false;
  // ts-morph exposes scope (private/public/protected) and readonly
  // separately; either marker promotes a constructor parameter to
  // a class field.
  return Boolean(param.getScope() || param.isReadonly());
}

function classifyByTypeAnnotation(
  decl: Node,
  visited: Set<Node>,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  if (
    !Node.isPropertyDeclaration(decl) &&
    !Node.isParameterDeclaration(decl)
  ) {
    return 'unresolved';
  }
  const typeNode = decl.getTypeNode();
  if (!typeNode) return 'unresolved';
  return classifyTypeNode(typeNode, visited, opts);
}

/**
 * #307 — Recursively classify a type node. Handles:
 *   - Direct `PrismaClient` references → 'client'
 *   - Class declarations (extending PrismaClient transitively) via
 *     `classifyClassDeclaration`
 *   - Type alias declarations (`type ExtendedPrismaClient = ...`) —
 *     follow the right-hand-side type node
 *   - `ReturnType<typeof X>` patterns — resolve X to a function
 *     declaration and classify its return expression(s)
 *
 * Used by `classifyByTypeAnnotation` (entry point for property/
 * parameter declarations) and recursively by itself for nested
 * type-level patterns.
 */
function classifyTypeNode(
  typeNode: Node,
  visited: Set<Node>,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  if (!Node.isTypeReference(typeNode)) return 'unresolved';
  const typeName = typeNode.getTypeName();
  if (!Node.isIdentifier(typeName)) return 'unresolved';

  // Direct: type IS PrismaClient (rare in DI, but possible).
  if (typeName.getText() === 'PrismaClient') return 'client';

  // #307 — `ReturnType<typeof X>` unwrap. Used by codebases that
  // expose a factory and declare the receiver type via the
  // factory's return:
  //   type ExtendedPrismaClient = ReturnType<typeof extendPrismaClient>;
  //   function extendPrismaClient() { return prisma.$extends(...) }
  // Resolve X (a function) and classify its return statements via
  // `classifyFactoryReturns`, which already handles `$extends`
  // recursion thanks to the CallExpression branch in `classify`.
  if (typeName.getText() === 'ReturnType') {
    const typeArgs = typeNode.getTypeArguments();
    if (typeArgs.length === 1) {
      const arg = typeArgs[0];
      if (Node.isTypeQuery(arg)) {
        const exprName = arg.getExprName();
        if (Node.isIdentifier(exprName)) {
          const sym = exprName.getSymbol();
          if (sym) {
            for (const d of sym.getDeclarations()) {
              if (Node.isFunctionDeclaration(d) && d.hasBody()) {
                const kind = classifyFactoryReturns(d, visited, opts);
                if (kind !== 'unresolved') {
                  if (kind === 'client') opts?.onTrace?.('returntype-typeof');
                  return kind;
                }
              }
              if (Node.isVariableDeclaration(d)) {
                const init = d.getInitializer();
                if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
                  const kind = classifyFactoryReturns(init, visited, opts);
                  if (kind !== 'unresolved') {
                    if (kind === 'client') opts?.onTrace?.('returntype-typeof');
                    return kind;
                  }
                }
              }
            }
          }
        }
      }
    }
    return 'unresolved';
  }

  // Resolve the type identifier to its declarations.
  const symbol = typeName.getSymbol();
  if (!symbol) return 'unresolved';
  for (const targetDecl of symbol.getDeclarations()) {
    if (Node.isClassDeclaration(targetDecl) || Node.isClassExpression(targetDecl)) {
      const kind = classifyClassDeclaration(targetDecl, visited, opts);
      if (kind !== 'unresolved') return kind;
    }
    // #307 — Type alias chain:
    //   type ExtendedPrismaClient = ReturnType<typeof extendPrismaClient>;
    //   type PrismaService = PrismaClient; // simple alias
    // Follow the alias to its right-hand-side and recurse.
    if (Node.isTypeAliasDeclaration(targetDecl)) {
      const aliasTypeNode = targetDecl.getTypeNode();
      if (aliasTypeNode) {
        const kind = classifyTypeNode(aliasTypeNode, visited, opts);
        if (kind !== 'unresolved') return kind;
      }
    }
    // Cross-file: imported symbol → recurse via classifyDeclaration.
    if (
      Node.isImportSpecifier(targetDecl) ||
      Node.isImportClause(targetDecl) ||
      Node.isNamespaceImport(targetDecl)
    ) {
      const kind = classifyImportedBinding(targetDecl, visited, opts);
      if (kind !== 'unresolved') return kind;
    }
  }
  return 'unresolved';
}

/**
 * Classify a class declaration:
 *   - extends PrismaClient → 'client'
 *   - extends some other named class → recurse to determine 'client'
 *     or 'not-prisma'
 *   - any field initializer reaches `new PrismaClient()` → 'client'
 *   - extends a `new <X>()` we resolve to non-Prisma → 'not-prisma'
 *   - otherwise → 'unresolved'
 */
function classifyClassDeclaration(
  cls: Node,
  visited: Set<Node>,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  if (visited.has(cls)) return 'unresolved';
  visited.add(cls);
  if (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls)) {
    return 'unresolved';
  }
  // 1. extends PrismaClient (or chain ending there).
  const extendsExpr = cls.getExtends();
  if (extendsExpr) {
    const expr = extendsExpr.getExpression();
    if (Node.isIdentifier(expr) && expr.getText() === 'PrismaClient') {
      return 'client';
    }
    // Resolve the extends target (cross-file capable) and recurse.
    if (Node.isIdentifier(expr)) {
      const sym = expr.getSymbol();
      if (sym) {
        for (const ed of sym.getDeclarations()) {
          if (Node.isClassDeclaration(ed) || Node.isClassExpression(ed)) {
            const kind = classifyClassDeclaration(ed, visited, opts);
            if (kind !== 'unresolved') return kind;
          }
        }
      }
    }
  }
  // 2. Any field bound to `new PrismaClient()` (wrap-not-extend).
  const kinds: PrismaReceiverKind[] = [];
  for (const member of cls.getMembers()) {
    if (Node.isPropertyDeclaration(member)) {
      const init = member.getInitializer();
      if (init) {
        const k = classify(init, visited, opts);
        if (k !== 'unresolved') kinds.push(k);
      }
    }
  }
  return kinds.length === 0 ? 'unresolved' : mergeKinds(kinds);
}

function scanAssignmentsForField(
  body: Node,
  fieldName: string,
  visited: Set<Node>,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  let result: PrismaReceiverKind = 'unresolved';
  body.forEachDescendant((d, traversal) => {
    if (result !== 'unresolved') {
      traversal.stop();
      return;
    }
    if (!Node.isBinaryExpression(d)) return;
    if (d.getOperatorToken().getText() !== '=') return;
    const left = d.getLeft();
    if (!Node.isPropertyAccessExpression(left)) return;
    if (!Node.isThisExpression(left.getExpression())) return;
    if (left.getNameNode().getText() !== fieldName) return;
    const kind = classify(d.getRight(), visited, opts);
    if (kind !== 'unresolved') {
      result = kind;
      traversal.stop();
    }
  });
  return result;
}

function classifyByAssignment(
  decl: Node,
  bindingName: string,
  visited: Set<Node>,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  const scope = decl.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isFunctionExpression(a) ||
      Node.isArrowFunction(a) ||
      Node.isMethodDeclaration(a) ||
      Node.isConstructorDeclaration(a) ||
      Node.isSourceFile(a),
  );
  if (!scope) return 'unresolved';

  let result: PrismaReceiverKind = 'unresolved';
  scope.forEachDescendant((d, traversal) => {
    if (result !== 'unresolved') {
      traversal.stop();
      return;
    }
    if (!Node.isBinaryExpression(d)) return;
    if (d.getOperatorToken().getText() !== '=') return;
    const left = d.getLeft();
    if (!Node.isIdentifier(left)) return;
    if (left.getText() !== bindingName) return;
    const kind = classify(d.getRight(), visited, opts);
    if (kind !== 'unresolved') {
      result = kind;
      traversal.stop();
    }
  });
  return result;
}

/**
 * #368 — Scan the enclosing source file for assignments of the form
 *   global.<fieldName>     = <rhs>
 *   globalThis.<fieldName> = <rhs>
 * and classify the right-hand sides. Used when the receiver chain
 * lands on `global.<X>` / `globalThis.<X>` — the canonical Next.js
 * + Prisma "hot-reload guard" pattern:
 *
 *   declare const global: { prisma?: PrismaClient };
 *   if (!global.prisma) global.prisma = new PrismaClient(...);
 *   export default global.prisma;
 *
 * The property type alone has no traceable initializer; the value
 * lives at a SEPARATE assignment expression which standard symbol
 * resolution doesn't follow. This helper walks the enclosing file,
 * collects every matching assignment, classifies each RHS, and
 * merges. Catches the typebot.io shape:
 *   `if (!global.prisma) { global.prisma = new PrismaClient({...}); }`
 */
function classifyGlobalPropertyAssignments(
  expr: Node,
  fieldName: string,
  visited: Set<Node>,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  const file = expr.getSourceFile();
  if (!file) return 'unresolved';
  const kinds: PrismaReceiverKind[] = [];
  file.forEachDescendant((d, traversal) => {
    if (!Node.isBinaryExpression(d)) return;
    if (d.getOperatorToken().getText() !== '=') return;
    const left = d.getLeft();
    if (!Node.isPropertyAccessExpression(left)) return;
    const recv = left.getExpression();
    if (!Node.isIdentifier(recv)) return;
    const recvName = recv.getText();
    if (recvName !== 'global' && recvName !== 'globalThis') return;
    if (left.getNameNode().getText() !== fieldName) return;
    const kind = classify(d.getRight(), visited, opts);
    if (kind !== 'unresolved') kinds.push(kind);
    // Don't stop traversal — `if (!global.prisma) global.prisma = ...`
    // may have multiple assignments; merge them all.
    void traversal;
  });
  if (kinds.length === 0) return 'unresolved';
  return mergeKinds(kinds);
}

function classifyImportedBinding(
  decl: Node,
  visited: Set<Node>,
  opts?: ClassifyOpts,
): PrismaReceiverKind {
  let current: Node | undefined = decl;
  while (current && !Node.isImportDeclaration(current)) {
    current = current.getParent();
  }
  if (!current || !Node.isImportDeclaration(current)) return 'unresolved';

  const targetFile = current.getModuleSpecifierSourceFile();
  if (!targetFile) return 'unresolved';
  const exportName = Node.isImportSpecifier(decl)
    ? decl.getName()
    : Node.isImportClause(decl)
    ? 'default'
    : null;
  if (!exportName) return 'unresolved';
  const exportedDecls = targetFile.getExportedDeclarations().get(exportName);
  if (!exportedDecls || exportedDecls.length === 0) return 'unresolved';
  return mergeKinds(
    exportedDecls.map((exported) => {
      // #368 — Expressions before declarations. `getExportedDeclarations`
      // for `export default global.prisma` returns the property-access
      // expression directly. `classifyDeclaration` doesn't recognise
      // it but DOES add the node to `visited` as a side effect,
      // which previously blocked the `classify(exported)` fallback
      // from reaching the new `global / globalThis` branch.
      if (Node.isExpression(exported)) {
        const kindExpr = classify(exported, visited, opts);
        if (kindExpr !== 'unresolved') return kindExpr;
      }
      const kind1 = classifyDeclaration(exported, visited, opts);
      if (kind1 !== 'unresolved') return kind1;
      return 'unresolved';
    }),
  );
}

/**
 * Merge multiple classification results from a symbol's declaration
 * list (or an import target's exported declarations).
 *
 * Precedence: any positive `'client'` wins. If no positive but a
 * definitive `'not-prisma'` exists, return that. Otherwise
 * `'unresolved'`. This way mixed evidence prefers the strongest
 * positive signal but won't manufacture a false `'unresolved'` when
 * we have a definitive negative.
 */
function mergeKinds(kinds: PrismaReceiverKind[]): PrismaReceiverKind {
  let saw: PrismaReceiverKind = 'unresolved';
  for (const k of kinds) {
    if (k === 'client') return 'client';
    if (k === 'not-prisma') saw = 'not-prisma';
  }
  return saw;
}

/**
 * #317 — Allowlisted higher-order singleton wrapper names. Each takes
 * a factory callback and returns its memoized result. Encountering one
 * of these as the call's callee lets us recurse into the callback's
 * return expression to reach the underlying `new PrismaClient()`.
 *
 * The set is intentionally small: only widely-used memoize idioms.
 * Adding a name here is conservative — false positives would mean
 * mis-classifying as Prisma, but the inner `'not-prisma'` check on
 * the factory's return still applies (a wrapper around
 * `new MongoClient()` returns `'not-prisma'`, definitively).
 */
const HOF_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  'remember', // Documenso's helper
  'memoize',
  'memo',
  'once',
  'singleton',
]);

function hofWrapperName(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) {
    const text = callee.getText();
    if (HOF_WRAPPER_NAMES.has(text)) return text;
  }
  // `lodash.memoize(...)` — accept a member access whose property
  // name is in the allowlist, regardless of receiver.
  if (Node.isPropertyAccessExpression(callee)) {
    const propName = callee.getNameNode().getText();
    if (HOF_WRAPPER_NAMES.has(propName)) return propName;
  }
  return null;
}

/**
 * Classify a factory callback's possible return values. For
 * concise-body arrows (`() => expr`), this is the body itself; for
 * block-body callbacks (`() => { if (cond) return a; return b; }`),
 * walk every `ReturnStatement` descendant and merge — any arm that
 * resolves to `'client'` wins. This generalizes the previous
 * "last-return-wins" rule, which silently dropped early-return
 * branches like the dominant Next.js Prisma idiom:
 *
 *   remember('prisma', () => {
 *     if (process.env.NODE_ENV === 'production') return new PrismaClient();
 *     if (!global.prisma) global.prisma = new PrismaClient();
 *     return global.prisma;
 *   });
 *
 * Mirrors the BinaryExpression / Conditional treatment elsewhere
 * in `classify`: precedence is `'client'` > `'not-prisma'` >
 * `'unresolved'` via `mergeKinds`.
 */
function classifyFactoryReturns(fn: Node, visited: Set<Node>, opts?: ClassifyOpts): PrismaReceiverKind {
  // #323 — FunctionDeclaration also accepted so free-function
  // factories (`function getPrisma() { return new PrismaClient() }`)
  // resolve. Without this, `await getPrisma()` and direct calls
  // through a FunctionDeclaration landed at 'unresolved'.
  if (
    !Node.isArrowFunction(fn) &&
    !Node.isFunctionExpression(fn) &&
    !Node.isFunctionDeclaration(fn)
  ) {
    return 'unresolved';
  }
  const body = fn.getBody();
  // Concise body — arrow with non-block expression.
  if (Node.isArrowFunction(fn) && body && !Node.isBlock(body)) {
    return classify(body, visited, opts);
  }
  if (!body || !Node.isBlock(body)) return 'unresolved';
  // Block body — collect every `ReturnStatement` descendant and
  // classify their expressions. Skip nested CALLABLE scopes
  // (functions, methods, accessors, constructors) — their `return`
  // statements belong to a different callable. Reviewer of #321
  // flagged that a missing `GetAccessor` skip would leak returns
  // from a nested object accessor into the outer classification.
  const kinds: PrismaReceiverKind[] = [];
  body.forEachDescendant((d, traversal) => {
    if (isCallableScope(d)) {
      traversal.skip();
      return;
    }
    if (Node.isReturnStatement(d)) {
      const e = d.getExpression();
      if (e) kinds.push(classify(e, visited, opts));
    }
  });
  if (kinds.length === 0) return 'unresolved';
  return mergeKinds(kinds);
}

function isCallableScope(d: Node): boolean {
  return (
    Node.isFunctionDeclaration(d) ||
    Node.isFunctionExpression(d) ||
    Node.isArrowFunction(d) ||
    Node.isMethodDeclaration(d) ||
    Node.isGetAccessorDeclaration(d) ||
    Node.isSetAccessorDeclaration(d) ||
    Node.isConstructorDeclaration(d)
  );
}

/**
 * Decide whether a `NewExpression` is `new PrismaClient(...)`. The
 * constructor identifier name is the discriminator. A `NewExpression`
 * with a different constructor name is `'not-prisma'` (definitive
 * negative — caller must NOT fall back to a name heuristic).
 */
/**
 * #388 — If `decl` is a parameter of an arrow function / function
 * expression that appears as an argument to `<receiver>.$transaction(...)`,
 * recurse on `<receiver>`. Prisma's interactive-transaction API:
 *
 *   await prisma.$transaction(async (tx) => {
 *     await tx.user.update(...);
 *     await tx.participant.deleteMany(...);
 *   });
 *
 * binds `tx` to the same client as the outer receiver. Receiver
 * detection should therefore treat `tx.<model>.<op>(...)` the same
 * as `prisma.<model>.<op>(...)`.
 *
 * Returns 'unresolved' when the parameter is not in a $transaction
 * callback (caller falls through to the standard type-annotation path).
 */
function classifyTransactionCallbackParam(
  param: Node,
  visited: Set<Node>,
  opts: ClassifyOpts | undefined,
): PrismaReceiverKind {
  if (!Node.isParameterDeclaration(param)) return 'unresolved';
  const fn = param.getParent();
  if (!fn || (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn))) {
    return 'unresolved';
  }
  // The function must be a direct argument to a $transaction call.
  const call = fn.getParent();
  if (!call || !Node.isCallExpression(call)) return 'unresolved';
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return 'unresolved';
  if (callee.getNameNode().getText() !== '$transaction') return 'unresolved';
  // The fn must be one of the call's arguments.
  const args = call.getArguments();
  if (!args.includes(fn)) return 'unresolved';
  // Recurse on the receiver of `.$transaction`.
  return classify(callee.getExpression(), visited, opts);
}

function classifyNewExpression(call: Node): PrismaReceiverKind {
  if (!Node.isNewExpression(call)) return 'unresolved';
  const callee = call.getExpression();
  if (Node.isIdentifier(callee) && callee.getText() === 'PrismaClient') {
    return 'client';
  }
  if (Node.isPropertyAccessExpression(callee) && callee.getNameNode().getText() === 'PrismaClient') {
    return 'client';
  }
  // Resolved to a different constructor — definitive negative.
  return 'not-prisma';
}
