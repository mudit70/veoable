import * as path from 'node:path';
import { Node, type Node as TsNode } from 'ts-morph';
import { idFor, type ClientSideProcess, type NavigatorKind, type ProcessKind, type Screen, type TriggersEdge } from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence, resolveIdentifierTypeToDeclaration, resolveFunctionDefinitionIdFromDecl } from '@veoable/lang-ts';

/**
 * React Native framework visitor (#167).
 *
 * Detects:
 *  1. **JSX event handlers** — same as React web (onPress, onSubmit, etc.)
 *     but stamped framework: 'react-native'. Also detects RN-specific
 *     events: onPress, onLongPress, onPressIn, onPressOut, onScroll,
 *     onRefresh, onEndReached.
 *
 *  2. **React lifecycle hooks** — useEffect, useLayoutEffect, useInsertionEffect.
 *
 *  3. **Navigation calls** — navigation.navigate('ScreenName'),
 *     navigation.push('ScreenName'), router.push('/path') (Expo Router).
 *     Emits NAVIGATES_TO edges to Screen nodes.
 *
 *  4. **Stack.Screen declarations** — <Stack.Screen name="X" component={Y}/>.
 *     Emits Screen nodes with SCREEN_COMPONENT edges.
 */

const LIFECYCLE_HOOKS: ReadonlySet<string> = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
]);

/** Navigation methods that take a screen name/path as the first string argument. */
const NAVIGATION_METHODS_WITH_TARGET: ReadonlySet<string> = new Set([
  'navigate', 'push', 'replace',
]);

/** Expo Router uses `router.push('/path')` instead of `navigation.navigate()`. */
const EXPO_ROUTER_OBJECTS: ReadonlySet<string> = new Set([
  'router', // import { router } from 'expo-router'
]);

/**
 * Receiver identifiers that indicate a React Navigation object.
 * Guards against false positives from `array.push('x')`, `string.replace('x')`, etc.
 */
const NAVIGATION_RECEIVERS: ReadonlySet<string> = new Set([
  'navigation', 'nav', 'navigator',
]);

type VisitorContext = Parameters<TsFrameworkVisitor['onNode']>[0];

export function createReactNativeVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      // ── JSX event handler attributes ──────────────────────────────
      if (Node.isJsxAttribute(node)) {
        const nameNode = node.getNameNode();
        if (!Node.isIdentifier(nameNode)) return;
        const attrName = nameNode.getText();
        if (!isEventHandlerAttribute(attrName)) return;
        if (!ctx.enclosingFunction) return;

        const process = buildProcess({
          kind: 'event_handler',
          name: attrName,
          ctx,
          sourceLine: node.getStartLineNumber(),
          astNode: node,
        });
        ctx.emitNode(process);

        // #266 — emit a TRIGGERS edge from the process to the handler
        // function. Without this, the flow walker can't traverse from
        // an onPress / onChangeText into the handler body — every RN
        // event-handler process is otherwise an orphan.
        const handlerFunctionId = resolveJsxHandlerFunctionId(node, attrName, ctx);
        if (handlerFunctionId) {
          const edge: TriggersEdge = {
            edgeType: 'TRIGGERS',
            from: process.id,
            to: handlerFunctionId,
          };
          ctx.emitEdge(edge);
        }
        return;
      }

      // ── React lifecycle hook calls ────────────────────────────────
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        // useEffect/useLayoutEffect
        if (Node.isIdentifier(callee) && LIFECYCLE_HOOKS.has(callee.getText())) {
          if (!ctx.enclosingFunction) return;

          const process = buildProcess({
            kind: 'lifecycle_hook',
            name: callee.getText(),
            ctx,
            sourceLine: node.getStartLineNumber(),
            astNode: node,
          });
          ctx.emitNode(process);
          return;
        }

        // Navigation calls: navigation.navigate('Screen') or router.push('/path')
        if (Node.isPropertyAccessExpression(callee)) {
          const methodName = callee.getNameNode().getText();
          if (NAVIGATION_METHODS_WITH_TARGET.has(methodName)) {
            if (!ctx.enclosingFunction) return;

            // Guard: check receiver is a navigation object or Expo Router,
            // to avoid false positives from array.push(), string.replace(), etc.
            const objectExpr = callee.getExpression();
            const isExpoRouter = Node.isIdentifier(objectExpr) &&
              EXPO_ROUTER_OBJECTS.has(objectExpr.getText());
            const isNavigation = Node.isIdentifier(objectExpr) &&
              NAVIGATION_RECEIVERS.has(objectExpr.getText());

            if (!isExpoRouter && !isNavigation) return;

            // Extract screen name from first string argument
            const args = node.getArguments();
            if (args.length > 0) {
              const firstArg = args[0];
              if (Node.isStringLiteral(firstArg)) {
                const screenName = firstArg.getLiteralValue();

                // For Expo Router, the name is a path; derive screen name from it
                const name = isExpoRouter
                  ? screenName.replace(/^\//, '').replace(/\//g, '-') || 'index'
                  : screenName;

                const screenId = idFor.screen({
                  repository: ctx.sourceFile.repository,
                  name,
                });

                ctx.emitEdge({
                  edgeType: 'NAVIGATES_TO',
                  from: ctx.enclosingFunction.id,
                  to: screenId,
                  method: methodName,
                  sourceLine: node.getStartLineNumber(),
                });
              }
            }
          }
        }

        return;
      }

      // ── Stack.Screen / Tab.Screen declarations ─────────────────────
      if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node)) {
        const tagName = node.getTagNameNode().getText();
        if (!tagName.endsWith('.Screen')) return;

        // Extract navigator kind from tag prefix
        const navigatorKind: NavigatorKind = tagName.startsWith('Stack') ? 'stack'
          : tagName.startsWith('Tab') ? 'tab'
          : tagName.startsWith('Drawer') ? 'drawer'
          : 'other';

        // Extract name and component props
        const nameAttr = getJsxAttributeValue(node, 'name');

        if (!nameAttr) return;

        // #127 — same-file deep-link resolution. When a `linking`
        // ObjectLiteral lives at module scope with `config.screens`
        // mapping screen names to URL patterns, populate routePath
        // for the matching screen. Cross-file linking config is out
        // of scope here.
        //
        // IMPORTANT: routePath is payload-only; it must NOT be
        // hashed into the Screen id. Imperative
        // `navigation.navigate('X')` callers compute the target
        // Screen id with `routePath: null` (they have no way to
        // resolve the linking config), so including it here would
        // orphan every NAVIGATES_TO edge. Schema guarantee at
        // packages/schema/src/ids.ts:105-107: RN producers pass
        // `routePath: null` to preserve identity.
        const routePath = resolveDeepLinkRoutePath(node, nameAttr);

        const screenId = idFor.screen({
          repository: ctx.sourceFile.repository,
          name: nameAttr,
        });

        // Resolve component prop to a FunctionDefinition ID via cross-file import tracing
        const componentFunctionId = resolveComponentFromJsx(node, ctx);

        const screen: Screen = {
          nodeType: 'Screen',
          id: screenId,
          name: nameAttr,
          componentFunctionId,
          navigatorKind,
          ...(routePath !== null ? { routePath } : {}),
          sourceFileId: ctx.sourceFile.id,
          sourceLine: node.getStartLineNumber(),
          framework: 'react-native',
          repository: ctx.sourceFile.repository,
          evidence: buildEvidence(node, ctx.sourceFile.filePath),
        };
        ctx.emitNode(screen);

        // Emit SCREEN_COMPONENT edge if component was resolved
        if (componentFunctionId) {
          ctx.emitEdge({
            edgeType: 'SCREEN_COMPONENT',
            from: screenId,
            to: componentFunctionId,
          });
        }

        return;
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Cross-file component resolution (Phase 4, #167)
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the `component` attribute of a JSX element (e.g.,
 * `<Stack.Screen component={HomeScreen}/>`) to a FunctionDefinition ID
 * by finding the identifier node and tracing its symbol declaration.
 *
 * Handles:
 *  - Same-file component: function/const declared in the same file
 *  - Cross-file import: `import X from './X'` or `import { X } from './screens'`
 */
function resolveComponentFromJsx(
  jsxElement: TsNode,
  ctx: VisitorContext,
): string | null {
  const identifierNode = findJsxAttributeIdentifier(jsxElement, 'component');
  if (!identifierNode) return null;

  const symbol = identifierNode.getSymbol();
  if (!symbol) return null;

  const decls = symbol.getDeclarations();
  if (decls.length === 0) return null;
  const decl = decls[0];

  // Cross-file: import declaration
  if (
    Node.isImportSpecifier(decl) ||
    Node.isImportClause(decl) ||
    Node.isNamespaceImport(decl)
  ) {
    return resolveCrossFileComponent(decl, identifierNode.getText(), ctx);
  }

  // #289 — same-file HOC: `const Player = connect(...)(PlayerClass)`.
  // The variable's initializer is a CallExpression; walk through HOC
  // layers to land on the underlying class / function decl.
  let resolvedDecl: TsNode = decl;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && Node.isCallExpression(init) && isHocCallExpression(init)) {
      resolvedDecl = unwrapHocCallChain(init);
    }
  }

  // Same-file: function, class, or variable declaration
  const fnNode = unwrapToFunction(resolvedDecl);
  if (!fnNode) return null;
  if (fnNode.getSourceFile() !== jsxElement.getSourceFile()) return null;

  const name = getFunctionName(resolvedDecl, fnNode);
  if (!name) return null;

  return idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name,
    sourceLine: fnNode.getStartLineNumber(),
  });
}

/**
 * Resolve a component that is imported from another file.
 */
function resolveCrossFileComponent(
  importDecl: TsNode,
  identifierName: string,
  ctx: VisitorContext,
): string | null {
  let targetFile;
  try {
    let current = importDecl as TsNode;
    while (current && !Node.isImportDeclaration(current)) {
      current = current.getParent() as TsNode;
    }
    if (!current || !Node.isImportDeclaration(current)) return null;
    targetFile = current.getModuleSpecifierSourceFile();
  } catch {
    return null;
  }

  if (!targetFile) return null;

  const targetFilePath = path.posix.normalize(
    path.relative(ctx.rootDir, targetFile.getFilePath()).split(path.sep).join('/'),
  );
  const targetSourceFileId = idFor.sourceFile({
    repository: ctx.repository,
    filePath: targetFilePath,
  });

  // For default imports, look up 'default' export; for named imports, use the identifier name
  const isDefault = Node.isImportClause(importDecl);
  const exportName = isDefault ? 'default' : identifierName;
  const targetSymbol = targetFile.getExportedDeclarations().get(exportName);
  if (!targetSymbol || targetSymbol.length === 0) return null;

  const targetDecl = targetSymbol[0];

  // #289 — HOC unwrap: when the export is `connect(...)(Player)` /
  // `observer(Player)` / `withRouter(Player)` / etc., walk through
  // the HOC wrapping to land on the underlying class / function.
  // Apply at both decl shapes:
  //   - The targetDecl itself is a CallExpression (typical for
  //     `export default connect(...)(Player)`).
  //   - The targetDecl is a VariableDeclaration whose initializer is
  //     an HOC CallExpression (typical for
  //     `const Player = connect(...)(PlayerClass); export default Player`).
  let resolvedDecl: TsNode = targetDecl;
  if (Node.isCallExpression(targetDecl) && isHocCallExpression(targetDecl)) {
    resolvedDecl = unwrapHocCallChain(targetDecl);
  } else if (Node.isVariableDeclaration(targetDecl)) {
    const init = targetDecl.getInitializer();
    if (init && Node.isCallExpression(init) && isHocCallExpression(init)) {
      resolvedDecl = unwrapHocCallChain(init);
    }
  }

  const fnNode = unwrapToFunction(resolvedDecl);
  if (!fnNode) return null;

  const name = getFunctionName(resolvedDecl, fnNode);
  if (!name) return null;

  return idFor.functionDefinition({
    sourceFileId: targetSourceFileId,
    name,
    sourceLine: fnNode.getStartLineNumber(),
  });
}

/**
 * #289 — Names of common Higher-Order Components that wrap class /
 * function components. When a Screen's `component={X}` resolves to a
 * CallExpression whose innermost callee is one of these, we walk INTO
 * the wrapped argument to find the actual class / function.
 *
 * Conservative allowlist: arbitrary `someFn(Component)` shouldn't be
 * unwrapped — only well-known HOC patterns. Adding to this set is safe
 * (more flows resolve); removing is risky (existing flows break).
 */
const KNOWN_HOC_NAMES: ReadonlySet<string> = new Set([
  'connect',         // react-redux
  'compose',         // redux, recompose
  'observer',        // mobx-react
  'inject',          // mobx-react
  'withRouter',      // react-router
  'withNavigation',  // react-navigation v4 (still common in RN codebases)
  'withTranslation', // react-i18next
  'memo',            // React.memo / memo
  'forwardRef',      // React.forwardRef / forwardRef
]);

/**
 * Determine whether a CallExpression looks like a known HOC pattern.
 * Walks down the callee chain (handles curried `connect(mapState)(C)`,
 * `withTranslation()(C)`, etc.) until it reaches an Identifier or
 * `<ns>.<name>` PropertyAccess, then checks the tail name.
 */
function isHocCallExpression(call: TsNode): boolean {
  if (!Node.isCallExpression(call)) return false;
  let cursor: TsNode = call;
  // Follow callee chain through any number of nested CallExpressions.
  while (Node.isCallExpression(cursor)) {
    cursor = cursor.getExpression();
  }
  let name: string | null = null;
  if (Node.isIdentifier(cursor)) name = cursor.getText();
  else if (Node.isPropertyAccessExpression(cursor)) name = cursor.getNameNode().getText();
  return name !== null && KNOWN_HOC_NAMES.has(name);
}

/**
 * Walk through HOC-wrapping CallExpressions until we land on a
 * non-call decl (typically a ClassDeclaration or VariableDeclaration).
 * Bounded loop so a pathological self-referential chain can't hang.
 */
function unwrapHocCallChain(decl: TsNode): TsNode {
  let cur: TsNode = decl;
  for (let i = 0; i < 5; i++) {
    if (!Node.isCallExpression(cur)) break;
    if (!isHocCallExpression(cur)) break;
    const args = cur.getArguments();
    if (args.length === 0) break;
    // The wrapped component is always the LAST argument of the
    // outermost call: `connect(mapState)(Player)` → `Player`,
    // `compose(a, b, c)(Component)` → `Component`,
    // `withRouter(Component)` → `Component`.
    const wrapped = args[args.length - 1];
    if (!Node.isIdentifier(wrapped)) break;
    const sym = wrapped.getSymbol();
    if (!sym) break;
    const wrappedDecls = sym.getDeclarations();
    if (wrappedDecls.length === 0) break;
    cur = wrappedDecls[0];
  }
  return cur;
}

/** Unwrap a declaration to its function-shaped node. */
function unwrapToFunction(decl: TsNode): TsNode | null {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isMethodDeclaration(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isFunctionExpression(decl)
  ) {
    return decl;
  }
  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer;
    }
  }
  // #267 — class component: bind the Screen to the class's `render`
  // method. lang-ts already emits class methods as
  // `<ClassName>.<method>` FunctionDefinitions (see
  // extract-source-file.ts:313). `render` is the closest analog to a
  // function component's body — it's where JSX, event handlers, and
  // child component instantiations live.
  if (Node.isClassDeclaration(decl)) {
    const render = decl.getInstanceMethod('render');
    if (render) return render;
  }
  return null;
}

/** Get the canonical function name from a declaration. */
function getFunctionName(decl: TsNode, fnNode: TsNode): string | null {
  if (Node.isFunctionDeclaration(fnNode)) return fnNode.getName() ?? null;
  if (Node.isVariableDeclaration(decl)) return decl.getName();
  // #267 — class component: name matches what lang-ts emits at
  // extract-source-file.ts:317 (`<ClassName>.<method>`).
  if (Node.isClassDeclaration(decl) && Node.isMethodDeclaration(fnNode)) {
    const cn = decl.getName();
    if (!cn) return null;
    return `${cn}.${fnNode.getName()}`;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// JSX attribute helpers
// ──────────────────────────────────────────────────────────────────────

function isEventHandlerAttribute(name: string): boolean {
  if (name.length < 3) return false;
  if (!name.startsWith('on')) return false;
  const thirdChar = name.charAt(2);
  return thirdChar >= 'A' && thirdChar <= 'Z';
}

/**
 * Find the Identifier node inside a JSX attribute's expression value.
 * For `component={HomeScreen}`, returns the `HomeScreen` Identifier node.
 * Returns null if the attribute is missing or not a simple identifier.
 */
function findJsxAttributeIdentifier(element: TsNode, attrName: string): TsNode | null {
  const attrs = Node.isJsxSelfClosingElement(element)
    ? element.getAttributes()
    : Node.isJsxOpeningElement(element)
      ? element.getAttributes()
      : [];

  for (const attr of attrs) {
    if (!Node.isJsxAttribute(attr)) continue;
    const nameNode = attr.getNameNode();
    if (!Node.isIdentifier(nameNode) || nameNode.getText() !== attrName) continue;

    const initializer = attr.getInitializer();
    if (!initializer || !Node.isJsxExpression(initializer)) return null;
    const expr = initializer.getExpression();
    if (expr && Node.isIdentifier(expr)) return expr;
    return null;
  }
  return null;
}

/**
 * Extract a string attribute value from a JSX element.
 * Handles: name="Home", name={'Home'}.
 * Returns null for non-string values (e.g., name={variable}) since
 * the variable's runtime value can't be statically determined here.
 */
function getJsxAttributeValue(element: TsNode, attrName: string): string | null {
  const attrs = Node.isJsxSelfClosingElement(element)
    ? element.getAttributes()
    : Node.isJsxOpeningElement(element)
      ? element.getAttributes()
      : [];

  for (const attr of attrs) {
    if (!Node.isJsxAttribute(attr)) continue;
    const nameNode = attr.getNameNode();
    if (!Node.isIdentifier(nameNode) || nameNode.getText() !== attrName) continue;

    const initializer = attr.getInitializer();
    if (!initializer) continue;

    // name="Home"
    if (Node.isStringLiteral(initializer)) {
      return initializer.getLiteralValue();
    }

    // name={'Home'}
    if (Node.isJsxExpression(initializer)) {
      const expr = initializer.getExpression();
      if (expr && Node.isStringLiteral(expr)) {
        return expr.getLiteralValue();
      }
    }
  }
  return null;
}

interface BuildProcessArgs {
  kind: ProcessKind;
  name: string;
  ctx: VisitorContext;
  sourceLine: number;
  astNode: TsNode;
}

function buildProcess(args: BuildProcessArgs): ClientSideProcess {
  const { kind, name, ctx, sourceLine, astNode } = args;
  const enclosing = ctx.enclosingFunction!;
  return {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      name,
    }),
    kind,
    name,
    functionId: enclosing.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    framework: 'react-native',
    repository: ctx.sourceFile.repository,
    evidence: buildEvidence(astNode, ctx.sourceFile.filePath),
  };
}

// ──────────────────────────────────────────────────────────────────────
// #127 — React Navigation deep-linking config
// ──────────────────────────────────────────────────────────────────────

/**
 * Same-file linking-config resolution for `<Stack.Screen name="X">`.
 *
 * Looks for a top-level `const linking = { ..., config: { screens: {
 * X: '<routePath>', ... } } }` declaration in the same source file
 * and returns the routePath assigned to the named screen.
 *
 * Accepted shapes for the per-screen value:
 *   - string literal: `Profile: 'profile/:id'`
 *   - object with a `path` key: `Profile: { path: 'profile/:id', ... }`
 *
 * Cross-file linking config (linking lives in a separate file from
 * the navigator) is out of scope for this iteration; the screen's
 * routePath stays null.
 */
function resolveDeepLinkRoutePath(jsxElement: TsNode, screenName: string): string | null {
  const sourceFile = jsxElement.getSourceFile();
  for (const stmt of sourceFile.getStatements()) {
    if (!Node.isVariableStatement(stmt)) continue;
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      if (!Node.isIdentifier(decl.getNameNode())) continue;
      // Liberal: any const named `linking` is a candidate.
      if (decl.getName() !== 'linking') continue;
      const init = decl.getInitializer();
      if (!init || !Node.isObjectLiteralExpression(init)) continue;
      const path = readScreensPath(init, screenName);
      if (path !== null) return path;
    }
  }
  return null;
}

/**
 * Read `linking.config.screens.<screenName>` from a `linking` object
 * literal. Returns null if any node along the path is missing or
 * non-literal.
 */
function readScreensPath(linkingObj: TsNode, screenName: string): string | null {
  if (!Node.isObjectLiteralExpression(linkingObj)) return null;
  const configProp = linkingObj.getProperty('config');
  if (!configProp || !Node.isPropertyAssignment(configProp)) return null;
  const configInit = configProp.getInitializer();
  if (!configInit || !Node.isObjectLiteralExpression(configInit)) return null;
  const screensProp = configInit.getProperty('screens');
  if (!screensProp || !Node.isPropertyAssignment(screensProp)) return null;
  const screensInit = screensProp.getInitializer();
  if (!screensInit || !Node.isObjectLiteralExpression(screensInit)) return null;
  const screenProp = screensInit.getProperty(screenName);
  if (!screenProp || !Node.isPropertyAssignment(screenProp)) return null;
  const screenInit = screenProp.getInitializer();
  if (!screenInit) return null;
  if (Node.isStringLiteral(screenInit)) return screenInit.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(screenInit)) return screenInit.getLiteralValue();
  // Object form: `Profile: { path: 'profile/:id', ... }`.
  if (Node.isObjectLiteralExpression(screenInit)) {
    const pathProp = screenInit.getProperty('path');
    if (pathProp && Node.isPropertyAssignment(pathProp)) {
      const pathInit = pathProp.getInitializer();
      if (pathInit && Node.isStringLiteral(pathInit)) return pathInit.getLiteralValue();
      if (pathInit && Node.isNoSubstitutionTemplateLiteral(pathInit)) return pathInit.getLiteralValue();
    }
  }
  return null;
}

/**
 * #266 — Resolve a JSX event-handler attribute's value to a
 * FunctionDefinition.id. Handles three shapes:
 *
 *   onPress={onLoginPress}                      — Identifier reference
 *   onPress={() => doSomething()}               — inline arrow
 *   onPress={async () => { await x(); }}        — inline async arrow
 *
 * Returns null when the attribute has no expression value or the
 * expression isn't shape-resolvable. Cross-file Identifier resolution
 * works via the shared `resolveFunctionDefinitionIdFromDecl` helper
 * from lang-ts (#263).
 */
function resolveJsxHandlerFunctionId(
  attrNode: TsNode,
  attrName: string,
  ctx: VisitorContext,
): string | null {
  if (!Node.isJsxAttribute(attrNode)) return null;
  const initializer = attrNode.getInitializer();
  if (!initializer || !Node.isJsxExpression(initializer)) return null;
  const expr = initializer.getExpression();
  if (!expr) return null;

  // Inline arrow / function expression at JsxExpression position.
  // lang-ts's inferCallbackName Pattern 1 names these
  // `<enclosingFn>.<attrName>$callback`. We compute the same id.
  if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
    const enclosingFn = ctx.enclosingFunction;
    if (!enclosingFn) return null;
    const callbackName = `${enclosingFn.name}.${attrName}$callback`;
    return idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name: callbackName,
      sourceLine: expr.getStartLineNumber(),
    });
  }

  // Identifier referring to a handler function. The type checker
  // resolves to whatever underlies the binding — FunctionDeclaration,
  // VariableDeclaration, or sometimes the arrow/fn-expr directly when
  // the binding is a variable initializer. The shared resolver handles
  // all of these via `isFunctionShape`.
  if (Node.isIdentifier(expr)) {
    const decl = resolveIdentifierTypeToDeclaration(expr, (d) => {
      return Node.isFunctionDeclaration(d)
        || Node.isVariableDeclaration(d)
        || Node.isArrowFunction(d)
        || Node.isFunctionExpression(d);
    });
    if (!decl) return null;
    return resolveFunctionDefinitionIdFromDecl(decl, ctx);
  }
  return null;
}
