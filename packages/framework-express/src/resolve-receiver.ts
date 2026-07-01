import { Node, type Expression } from 'ts-morph';

/**
 * Receiver classification for an Express-style route call.
 *
 * The express `Application` and `Router` types are structurally
 * identical for routing purposes (both expose `get`/`post`/...), so
 * the visitor treats them the same. We track which one the receiver
 * resolves to only for diagnostics.
 */
export type ExpressReceiverKind = 'app' | 'router' | 'unknown';

/**
 * Decide whether `expr` is an Express routable (an `Application`
 * created by `express()` or a `Router` created by `Router()` /
 * `express.Router()`), regardless of the variable name used to bind
 * it.
 *
 * The detection is AST-based and deterministic — no reliance on
 * receiver-name heuristics like `app` / `router`. We trace the
 * expression back to the call that produced it and check whether the
 * called factory was imported from the `express` package (or a local
 * stub that re-exports the same factory names, used in tests).
 *
 * Cases handled:
 *   - `const app = express(); app.get(...)`
 *   - `const router = Router(); router.get(...)`              (named import)
 *   - `const router = express.Router(); router.get(...)`      (default import)
 *   - `import express from 'express'`                          (default)
 *   - `import { Router } from 'express'`                       (named)
 *   - `import * as express from 'express'`                     (namespace)
 *   - `class S { app = express(); foo() { this.app.get(...) } }`     (field initializer)
 *   - `class S { constructor() { this.app = express(); } foo() { this.app.get(...) } }`  (constructor)
 *   - `let app: Express; app = express(); app.get(...)`        (reassignment)
 *   - `import { adminRouter } from './admin'; adminRouter.get(...)`  (cross-file)
 *   - The receiver expression *itself* being a routable call:
 *     `express().get('/x', ...)`, `Router().post(...)`
 *   - Method-chained routables: `app.use(mw).get(...)` — the
 *     receiver `app.use(mw)` returns the same routable.
 *
 * Visited declarations are tracked so cycles and aliasing chains
 * cannot loop forever.
 */
export function classifyExpressReceiver(expr: Expression): ExpressReceiverKind {
  const visited = new Set<Node>();
  return classify(expr, visited);
}

function classify(expr: Node, visited: Set<Node>): ExpressReceiverKind {
  if (visited.has(expr)) return 'unknown';
  visited.add(expr);

  // The receiver is itself a call: `express().get(...)`,
  // `Router().post(...)`, or any chained routable method
  // (`app.use(mw).get(...)`).
  if (Node.isCallExpression(expr)) {
    const direct = classifyFactoryCall(expr);
    if (direct !== 'unknown') return direct;
    // Method-chained routable: a routable's `use` / `route` etc. all
    // return another routable, so if the call's *receiver* is
    // routable, the call itself is too.
    const callee = expr.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
      return classify(callee.getExpression(), visited);
    }
    return 'unknown';
  }

  // `this.<field>` — trace to the class field's initializer or to a
  // constructor assignment.
  if (Node.isPropertyAccessExpression(expr)) {
    const left = expr.getExpression();
    const name = expr.getNameNode().getText();
    if (Node.isThisExpression(left)) {
      const cls = expr.getFirstAncestor(
        (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
      );
      if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
        return classifyClassField(cls, name, visited);
      }
    }
    // For non-`this` property access, fall through and try symbol
    // resolution on the whole expression.
  }

  // Identifier (or anything else with a symbol) — resolve through
  // ts-morph. We use the symbol's declarations rather than the type
  // because the type system frequently widens to `any` when the
  // express package's types aren't installed.
  if (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr)) {
    const symbol = (expr as Expression & { getSymbol?: () => unknown })
      .getSymbol?.() as { getDeclarations: () => Node[] } | undefined;
    if (!symbol) return 'unknown';
    const decls = symbol.getDeclarations();
    for (const decl of decls) {
      const kind = classifyDeclaration(decl, visited);
      if (kind !== 'unknown') return kind;
    }
  }

  return 'unknown';
}

/**
 * Inspect a single declaration node to see if it binds an Express
 * routable. Recurses through aliasing (variable → variable, import →
 * exported value) until it finds an originating factory call or
 * gives up.
 */
function classifyDeclaration(decl: Node, visited: Set<Node>): ExpressReceiverKind {
  if (visited.has(decl)) return 'unknown';
  visited.add(decl);

  // `const x = <init>` → recurse on the initializer.
  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer) {
      const kind = classify(initializer, visited);
      if (kind !== 'unknown') return kind;
    }
    // Handle `let x: ...; x = express()` reassignments by scanning
    // the enclosing scope for assignments to this binding.
    return classifyByAssignment(decl, decl.getName(), visited);
  }

  // Class field with an initializer (`class S { app = express() }`).
  if (Node.isPropertyDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer) {
      const kind = classify(initializer, visited);
      if (kind !== 'unknown') return kind;
    }
  }

  // Class field assigned in constructor (`this.app = express()`).
  if (Node.isPropertyDeclaration(decl) || Node.isPropertyAssignment(decl)) {
    const cls = decl.getFirstAncestor(
      (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
    );
    if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
      const fieldName = Node.isPropertyDeclaration(decl)
        ? decl.getName()
        : (decl.getNameNode().getText() ?? '');
      return classifyClassField(cls, fieldName, visited);
    }
  }

  // Imported binding — follow to the exported declaration in the
  // target module.
  if (
    Node.isImportSpecifier(decl) ||
    Node.isImportClause(decl) ||
    Node.isNamespaceImport(decl)
  ) {
    return classifyImportedBinding(decl, visited);
  }

  // Function parameter — we don't try to track call-site arguments
  // in here. Callers can still resolve the parameter's type if
  // they want.
  return 'unknown';
}

/**
 * Walk the body of `cls` looking for either:
 *   - a `<fieldName>: T = <init>` property declaration with a
 *     routable initializer, or
 *   - a `this.<fieldName> = <init>` assignment in the constructor
 *     (or any method) that initializes the field with a routable.
 */
function classifyClassField(
  cls: Node,
  fieldName: string,
  visited: Set<Node>,
): ExpressReceiverKind {
  // Field declarations.
  if (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) {
    for (const member of cls.getMembers()) {
      if (Node.isPropertyDeclaration(member) && member.getName() === fieldName) {
        const initializer = member.getInitializer();
        if (initializer) {
          const kind = classify(initializer, visited);
          if (kind !== 'unknown') return kind;
        }
      }
    }
    // Constructor / method assignments: `this.<fieldName> = <expr>`.
    for (const member of cls.getMembers()) {
      if (
        Node.isConstructorDeclaration(member) ||
        Node.isMethodDeclaration(member)
      ) {
        const body = member.getBody();
        if (!body) continue;
        const kind = scanAssignmentsForField(body, fieldName, visited);
        if (kind !== 'unknown') return kind;
      }
    }
  }
  return 'unknown';
}

function scanAssignmentsForField(
  body: Node,
  fieldName: string,
  visited: Set<Node>,
): ExpressReceiverKind {
  let result: ExpressReceiverKind = 'unknown';
  body.forEachDescendant((d, traversal) => {
    if (result !== 'unknown') {
      traversal.stop();
      return;
    }
    if (!Node.isBinaryExpression(d)) return;
    if (d.getOperatorToken().getText() !== '=') return;
    const left = d.getLeft();
    if (!Node.isPropertyAccessExpression(left)) return;
    if (!Node.isThisExpression(left.getExpression())) return;
    if (left.getNameNode().getText() !== fieldName) return;
    const kind = classify(d.getRight(), visited);
    if (kind !== 'unknown') {
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
): ExpressReceiverKind {
  // Walk outward until we leave the function/source-file scope so we
  // don't scan the entire program.
  const scope = decl.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isFunctionExpression(a) ||
      Node.isArrowFunction(a) ||
      Node.isMethodDeclaration(a) ||
      Node.isConstructorDeclaration(a) ||
      Node.isSourceFile(a),
  );
  if (!scope) return 'unknown';

  let result: ExpressReceiverKind = 'unknown';
  scope.forEachDescendant((d, traversal) => {
    if (result !== 'unknown') {
      traversal.stop();
      return;
    }
    if (!Node.isBinaryExpression(d)) return;
    if (d.getOperatorToken().getText() !== '=') return;
    const left = d.getLeft();
    if (!Node.isIdentifier(left)) return;
    if (left.getText() !== bindingName) return;
    const kind = classify(d.getRight(), visited);
    if (kind !== 'unknown') {
      result = kind;
      traversal.stop();
    }
  });
  return result;
}

function classifyImportedBinding(
  decl: Node,
  visited: Set<Node>,
): ExpressReceiverKind {
  // Walk up to the ImportDeclaration to learn the module specifier.
  let current: Node | undefined = decl;
  while (current && !Node.isImportDeclaration(current)) {
    current = current.getParent();
  }
  if (!current || !Node.isImportDeclaration(current)) return 'unknown';

  const moduleSpecifier = current.getModuleSpecifierValue();
  if (isExpressModuleSpecifier(moduleSpecifier)) {
    // Importing a binding directly from `express`. The name tells us
    // whether it's an `Application` factory or a `Router` factory.
    if (Node.isImportClause(decl)) return 'app'; // default import: `import express from 'express'`
    if (Node.isNamespaceImport(decl)) return 'app'; // `import * as express from 'express'`
    if (Node.isImportSpecifier(decl)) {
      const imported = decl.getName();
      if (imported === 'Router') return 'router';
      if (imported === 'default') return 'app';
      return 'unknown';
    }
    return 'unknown';
  }

  // Cross-file: follow the import to the target file's exported
  // declaration and recurse.
  const targetFile = current.getModuleSpecifierSourceFile();
  if (!targetFile) return 'unknown';
  const exportName = Node.isImportSpecifier(decl)
    ? decl.getName()
    : Node.isImportClause(decl)
    ? 'default'
    : null;
  if (!exportName) return 'unknown';
  const exportedDecls = targetFile.getExportedDeclarations().get(exportName);
  if (!exportedDecls || exportedDecls.length === 0) return 'unknown';
  for (const exported of exportedDecls) {
    const kind = classifyDeclaration(exported, visited);
    if (kind !== 'unknown') return kind;
    // Some exports are themselves expressions (re-exports of values).
    if (Node.isExpression(exported)) {
      const kind2 = classify(exported, visited);
      if (kind2 !== 'unknown') return kind2;
    }
  }
  return 'unknown';
}

/**
 * Decide whether a CallExpression *is* a call to an express factory
 * (`express()`, `Router()`, or `express.Router()`). Returns 'app',
 * 'router', or 'unknown'.
 */
function classifyFactoryCall(call: Node): ExpressReceiverKind {
  if (!Node.isCallExpression(call)) return 'unknown';
  const callee = call.getExpression();

  // `express.Router()` or `something.Router()` where `something`
  // is the express namespace import.
  if (Node.isPropertyAccessExpression(callee)) {
    const propName = callee.getNameNode().getText();
    if (propName !== 'Router') return 'unknown';
    return identifierResolvesToExpressImport(callee.getExpression())
      ? 'router'
      : 'unknown';
  }

  // Bare identifier call: `express()` or `Router()`.
  if (Node.isIdentifier(callee)) {
    const text = callee.getText();
    const kindIfExpress = identifierResolvesToExpressImport(callee);
    if (!kindIfExpress) return 'unknown';
    if (text === 'Router') return 'router';
    // Default / namespace import called as a function → Application.
    return 'app';
  }

  return 'unknown';
}

/**
 * Returns true if `expr` is an identifier whose declaration is an
 * import from the `express` package — directly, or via a chain of
 * local aliases (`const makeApp = express; makeApp()`).
 *
 * Conservative on purpose: we only accept imports whose module
 * specifier is exactly `express`, optionally with a `/...` suffix for
 * subpaths (e.g. `express/lib/...`). Local stub fixtures used in
 * tests declare the module name `express` via `declare module
 * 'express'` so they hit this same path.
 */
function identifierResolvesToExpressImport(expr: Node): boolean {
  return resolveIdentifierToExpressImport(expr, new Set<Node>());
}

function resolveIdentifierToExpressImport(expr: Node, visited: Set<Node>): boolean {
  if (visited.has(expr)) return false;
  visited.add(expr);
  if (!Node.isIdentifier(expr)) return false;
  const symbol = expr.getSymbol();
  if (!symbol) return false;
  for (const decl of symbol.getDeclarations()) {
    // Direct import: `import express from 'express'` etc.
    if (
      Node.isImportClause(decl) ||
      Node.isImportSpecifier(decl) ||
      Node.isNamespaceImport(decl)
    ) {
      let current: Node | undefined = decl;
      while (current && !Node.isImportDeclaration(current)) {
        current = current.getParent();
      }
      if (
        current &&
        Node.isImportDeclaration(current) &&
        isExpressModuleSpecifier(current.getModuleSpecifierValue())
      ) {
        return true;
      }
    }
    // Local alias: `const makeApp = express;` — recurse on the
    // initializer to see if *it* resolves to an express import.
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && Node.isIdentifier(init)) {
        if (resolveIdentifierToExpressImport(init, visited)) return true;
      }
    }
  }
  return false;
}

function isExpressModuleSpecifier(spec: string | undefined): boolean {
  if (!spec) return false;
  return spec === 'express' || spec.startsWith('express/');
}
