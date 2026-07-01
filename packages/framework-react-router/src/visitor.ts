import * as path from 'node:path';
import {
  Node,
  type JsxElement,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type Node as TsNode,
  type ObjectLiteralExpression,
} from 'ts-morph';
import {
  idFor,
  type Screen,
  type NavigatesToEdge,
  type ScreenComponentEdge,
} from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@veoable/lang-ts';

/**
 * react-router-dom framework visitor (#187 piece A).
 *
 * Detects:
 *   1. `<Route path="..." element={<Component/>} />` — emits a Screen
 *      node with the composed routePath, the resolved component
 *      function id, and a SCREEN_COMPONENT edge.
 *   2. Nested `<Route>` declarations — composes parent + child paths
 *      per react-router-dom v6 semantics (relative children join
 *      with `/`; absolute children starting with `/` override).
 *   3. `<Link to="..." />`, `<NavLink to="..." />`, `<Navigate to="..." />`
 *      — emits NAVIGATES_TO edges from the enclosing FunctionDefinition
 *      to the target Screen id.
 *
 * Out of scope (subsequent PRs):
 *   - `createBrowserRouter([{path, element}, ...])` config arrays.
 *   - `useNavigate()` and `redirect()` call detection.
 *
 * Conservative on path/component resolution:
 *   - `path` and `to` must be string literals or no-substitution
 *     templates. Computed values (`<Link to={dynamic}>`) are skipped.
 *   - `element` must be a JSX expression with a single component
 *     identifier (`<HomePage/>` or `<HomePage prop={x}/>`). Anonymous
 *     inline components (`<Route element={<div>...</div>}>`) skip the
 *     SCREEN_COMPONENT edge but still emit the Screen.
 *   - Component identifier resolution mirrors framework-react-native:
 *     follow the symbol declaration, traverse import re-exports, fall
 *     back to null if not found.
 */

type VisitorContext = Parameters<TsFrameworkVisitor['onNode']>[0];

const ROUTE_TAG = 'Route';
const LINK_TAGS: ReadonlySet<string> = new Set(['Link', 'NavLink', 'Navigate']);

export function createReactRouterVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      // <Route path="..." element={<Component/>}/> — Screen emission.
      if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node)) {
        const tagName = node.getTagNameNode().getText();

        if (tagName === ROUTE_TAG) {
          emitRouteScreen(node, ctx);
          return;
        }

        if (LINK_TAGS.has(tagName)) {
          emitLinkNavigation(node, ctx);
          return;
        }
      }

      // Round 7 — `createBrowserRouter([{path, element, children?}, …])`.
      // The data-router API; structurally equivalent to nested <Route>s.
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        if (Node.isIdentifier(callee) && CREATE_ROUTER_FUNCTIONS.has(callee.getText())) {
          const args = node.getArguments();
          if (args.length > 0 && Node.isArrayLiteralExpression(args[0])) {
            for (const el of args[0].getElements()) {
              if (Node.isObjectLiteralExpression(el)) {
                emitDataRouterRouteScreen(el, '', ctx, 0);
              }
            }
          }
          return;
        }

        // Round 7 — `redirect('/path')` and `<navigate>(<path>)` where
        // navigate was bound from `useNavigate()`. Emits NAVIGATES_TO
        // from the enclosing function to the target Screen.
        if (Node.isIdentifier(callee)) {
          const calleeText = callee.getText();
          if (calleeText === 'redirect') {
            emitProgrammaticNavigation(node, ctx, 'redirect');
            return;
          }
          if (isUseNavigateBinding(callee)) {
            emitProgrammaticNavigation(node, ctx, 'useNavigate');
            return;
          }
        }
      }
    },
  };
}

/** Functions returning a react-router data router from a route config array. */
const CREATE_ROUTER_FUNCTIONS: ReadonlySet<string> = new Set([
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
]);

/** Recursion depth ceiling for `children` arrays. Real configs nest a few
 *  levels; 8 is comfortable headroom while preventing stack overflow on
 *  malformed cyclic data. */
const MAX_DATA_ROUTER_DEPTH = 8;

// ──────────────────────────────────────────────────────────────────────
// <Route> → Screen
// ──────────────────────────────────────────────────────────────────────

function emitRouteScreen(
  routeElement: JsxOpeningElement | JsxSelfClosingElement,
  ctx: VisitorContext,
): void {
  // Compose the route path by walking up parent <Route> ancestors.
  const composedPath = composeRoutePath(routeElement);
  if (composedPath === null) return;

  // Resolve the `element` prop's component identifier.
  const componentFunctionId = resolveElementComponent(routeElement, ctx);

  // Resolve the parent <Route>'s Screen id (if any) for parentScreenId.
  const parentRouteEl = findEnclosingRouteJsxElement(routeElement);
  let parentScreenId: string | null = null;
  if (parentRouteEl) {
    const parentPath = composeRoutePath(getOpeningTag(parentRouteEl));
    if (parentPath !== null) {
      parentScreenId = idFor.screen({
        repository: ctx.sourceFile.repository,
        name: parentPath,
        routePath: parentPath,
      });
    }
  }

  const screenId = idFor.screen({
    repository: ctx.sourceFile.repository,
    name: composedPath,
    routePath: composedPath,
  });

  const screen: Screen = {
    nodeType: 'Screen',
    id: screenId,
    name: composedPath,
    componentFunctionId,
    navigatorKind: 'web-router',
    routePath: composedPath,
    parentScreenId,
    sourceFileId: ctx.sourceFile.id,
    sourceLine: routeElement.getStartLineNumber(),
    framework: 'react-router',
    repository: ctx.sourceFile.repository,
    evidence: buildEvidence(routeElement, ctx.sourceFile.filePath),
  };
  ctx.emitNode(screen);

  if (componentFunctionId) {
    ctx.emitEdge({
      edgeType: 'SCREEN_COMPONENT',
      from: screenId,
      to: componentFunctionId,
    } as ScreenComponentEdge);
  }
}

// ──────────────────────────────────────────────────────────────────────
// createBrowserRouter([{path, element, children?}, …]) → Screen
// ──────────────────────────────────────────────────────────────────────

/**
 * Round 7 — emit a Screen + optional SCREEN_COMPONENT edge for one
 * route-config object literal in a `createBrowserRouter([...])` array.
 * Recurses into `children: [...]` with the composed prefix.
 *
 * Path composition mirrors react-router-dom v6: a child path with
 * leading `/` is absolute and overrides the parent prefix; otherwise
 * it joins relative.
 */
function emitDataRouterRouteScreen(
  obj: ObjectLiteralExpression,
  parentPath: string,
  ctx: VisitorContext,
  depth: number,
): void {
  if (depth > MAX_DATA_ROUTER_DEPTH) return;

  const pathValue = getObjectStringProperty(obj, 'path');
  const indexProp = obj.getProperty('index');
  const isIndex = !!indexProp;

  // Compose this entry's path. Index routes contribute no segment;
  // they live at the parent path.
  let composed: string;
  if (isIndex) {
    composed = parentPath || '/';
  } else if (pathValue === null) {
    // Layout-only route (no path, no index) — still recurse children.
    composed = parentPath;
  } else if (pathValue.startsWith('/')) {
    composed = pathValue;
  } else {
    const sep = parentPath.endsWith('/') || parentPath === '' ? '' : '/';
    composed = `${parentPath}${sep}${pathValue}`;
  }
  composed = composed.replace(/\/+/g, '/');
  if (!composed.startsWith('/')) composed = '/' + composed;

  // Only emit a Screen when the entry actually contributes a path
  // (or is an index route). Pure layout entries (no path/index) are
  // pass-through containers — skip Screen emission, recurse children.
  const shouldEmit = pathValue !== null || isIndex;

  if (shouldEmit) {
    const screenId = idFor.screen({
      repository: ctx.sourceFile.repository,
      name: composed,
      routePath: composed,
    });
    const componentFunctionId = resolveDataRouterElementComponent(obj, ctx);
    // #239 NIT: compute parentScreenId from parentPath so data-router
    // screens have the same parent-chain shape as JSX <Route> screens.
    const parentScreenId = parentPath !== '' && parentPath !== composed
      ? idFor.screen({
        repository: ctx.sourceFile.repository,
        name: parentPath,
        routePath: parentPath,
      })
      : null;
    const screen: Screen = {
      nodeType: 'Screen',
      id: screenId,
      name: composed,
      componentFunctionId,
      navigatorKind: 'web-router',
      routePath: composed,
      parentScreenId,
      sourceFileId: ctx.sourceFile.id,
      sourceLine: obj.getStartLineNumber(),
      framework: 'react-router',
      repository: ctx.sourceFile.repository,
      evidence: buildEvidence(obj, ctx.sourceFile.filePath),
    };
    ctx.emitNode(screen);
    if (componentFunctionId) {
      const edge: ScreenComponentEdge = {
        edgeType: 'SCREEN_COMPONENT',
        from: screenId,
        to: componentFunctionId,
      };
      ctx.emitEdge(edge);
    }
  }

  // Recurse children.
  const childrenProp = obj.getProperty('children');
  if (childrenProp && Node.isPropertyAssignment(childrenProp)) {
    const init = childrenProp.getInitializer();
    if (init && Node.isArrayLiteralExpression(init)) {
      for (const el of init.getElements()) {
        if (Node.isObjectLiteralExpression(el)) {
          emitDataRouterRouteScreen(el, composed, ctx, depth + 1);
        }
      }
    }
  }
}

/**
 * Read `path` (string-literal or no-substitution-template) from an
 * object literal. Returns null when missing or not a static string.
 */
function getObjectStringProperty(obj: ObjectLiteralExpression, name: string): string | null {
  const prop = obj.getProperty(name);
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  if (!init) return null;
  if (Node.isStringLiteral(init)) return init.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(init)) return init.getLiteralValue();
  return null;
}

/**
 * Resolve the `element` property of a data-router route config to a
 * FunctionDefinition id. The value is a JSX expression (not a JSX
 * attribute) — `element: <Home />` rather than `element={<Home />}`.
 * Falls back to null on shapes the visitor doesn't handle yet.
 */
function resolveDataRouterElementComponent(
  obj: ObjectLiteralExpression,
  ctx: VisitorContext,
): string | null {
  const prop = obj.getProperty('element') ?? obj.getProperty('Component');
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  if (!init) return null;

  // `element: <Home />` — JSX self-closing or opening element directly.
  if (Node.isJsxSelfClosingElement(init) || Node.isJsxOpeningElement(init)) {
    const name = init.getTagNameNode();
    if (Node.isIdentifier(name)) return resolveIdentifierToFunctionId(name, ctx);
    return null;
  }
  if (Node.isJsxElement(init)) {
    const name = init.getOpeningElement().getTagNameNode();
    if (Node.isIdentifier(name)) return resolveIdentifierToFunctionId(name, ctx);
    return null;
  }
  // `Component: Home` — Identifier reference to a component function.
  if (Node.isIdentifier(init)) return resolveIdentifierToFunctionId(init, ctx);
  return null;
}

/**
 * Compose a routePath by walking up enclosing `<Route>` JsxElement
 * ancestors and collecting `path` (or `index`) attributes.
 *
 * react-router-dom v6 semantics:
 *   - A child path WITHOUT a leading `/` is relative — join with parent.
 *   - A child path WITH a leading `/` is absolute — overrides parent.
 *   - `index` attribute → empty path segment (route lives at parent path).
 *   - The outermost <Route> contributes its full path verbatim.
 *
 * Returns null when this <Route> has neither `path` nor `index` (e.g.,
 * a malformed declaration or an unsupported shape).
 */
function composeRoutePath(routeElement: JsxOpeningElement | JsxSelfClosingElement): string | null {
  const segments: string[] = [];

  // Walk up: routeElement → parent JsxElement (containing <Route>) → ...
  let current: JsxOpeningElement | JsxSelfClosingElement | null = routeElement;
  while (current) {
    const indexAttr = getJsxAttribute(current, 'index');
    const pathAttr = getJsxAttributeStringValue(current, 'path');

    if (pathAttr !== null) {
      if (pathAttr.startsWith('/')) {
        // Absolute path overrides: stop walking, this is the root.
        segments.unshift(pathAttr);
        break;
      } else {
        segments.unshift(pathAttr);
      }
    } else if (indexAttr !== null) {
      // Index route: contributes no segment to its own path; the
      // route lives at its parent's path.
      segments.unshift('');
    } else {
      return null;
    }

    // Walk to the parent <Route> (skip non-Route ancestors like <Routes>).
    current = findEnclosingRouteOpeningTag(current);
  }

  // Join segments with `/`. Skip empty (index) segments cleanly.
  let composed = segments
    .filter((s) => s !== '')
    .map((s, i) => (i === 0 || s.startsWith('/') ? s : '/' + s.replace(/^\/+/, '')))
    .join('');

  // Normalize: collapse multiple slashes; ensure leading `/`.
  composed = composed.replace(/\/+/g, '/');
  if (!composed.startsWith('/')) composed = '/' + composed;
  // Index route at the root: /
  if (composed === '') composed = '/';

  return composed;
}

/**
 * Find the parent <Route> opening tag of a given <Route> tag, or null
 * when this is the outermost <Route>. The parent must itself be a
 * JsxOpeningElement (a <Route>...</Route> with children); a parent
 * that's a JsxSelfClosingElement can't have children, so it can't be
 * an ancestor of another <Route>.
 *
 * Tree shape for nested routes:
 *   JsxElement (the <Route>...</Route>)
 *     openingElement: <Route ...>
 *     children: [..., JsxElement (nested <Route>), ...]
 *     closingElement: </Route>
 */
function findEnclosingRouteOpeningTag(
  child: JsxOpeningElement | JsxSelfClosingElement,
): JsxOpeningElement | null {
  // Walk up the AST. The child <Route>'s parent chain is:
  //   self → JsxElement (its own enclosing) → JsxElement (parent <Route>'s)
  //                                            → openingElement is the parent
  let current: TsNode | null = child.getParent();
  while (current) {
    if (Node.isJsxElement(current)) {
      const opening = current.getOpeningElement();
      if (opening.getTagNameNode().getText() === ROUTE_TAG && opening !== child) {
        return opening;
      }
    }
    current = current.getParent() ?? null;
  }
  return null;
}

function findEnclosingRouteJsxElement(
  child: JsxOpeningElement | JsxSelfClosingElement,
): JsxElement | null {
  let current: TsNode | null = child.getParent();
  while (current) {
    if (Node.isJsxElement(current)) {
      const opening = current.getOpeningElement();
      if (opening.getTagNameNode().getText() === ROUTE_TAG && opening !== child) {
        return current;
      }
    }
    current = current.getParent() ?? null;
  }
  return null;
}

function getOpeningTag(jsxElement: JsxElement): JsxOpeningElement {
  return jsxElement.getOpeningElement();
}

// ──────────────────────────────────────────────────────────────────────
// element={<Component/>} → componentFunctionId
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the JSX `element` attribute's component identifier to a
 * FunctionDefinition id. The attribute value is a JSX expression
 * containing JSX:
 *
 *   element={<HomePage />}
 *   element={<HomePage prop={x} />}
 *   element={<Navigate to="..." replace />}
 *
 * For redirect routes (Navigate), there's no user-defined component —
 * return null so the Screen still emits but has no SCREEN_COMPONENT
 * edge.
 *
 * Returns null on resolution failure rather than guessing.
 */
function resolveElementComponent(
  routeElement: JsxOpeningElement | JsxSelfClosingElement,
  ctx: VisitorContext,
): string | null {
  const attr = getJsxAttribute(routeElement, 'element');
  if (!attr || !Node.isJsxAttribute(attr)) return null;
  const init = attr.getInitializer();
  if (!init || !Node.isJsxExpression(init)) return null;
  const inner = init.getExpression();
  if (!inner) return null;

  // Look for the inner JSX element's tag.
  let tagName: string | null = null;
  if (Node.isJsxSelfClosingElement(inner) || Node.isJsxOpeningElement(inner)) {
    tagName = inner.getTagNameNode().getText();
  } else if (Node.isJsxElement(inner)) {
    tagName = inner.getOpeningElement().getTagNameNode().getText();
  }
  if (!tagName) return null;

  // Skip react-router built-ins — they aren't user-defined components.
  if (LINK_TAGS.has(tagName)) return null;

  // Find an Identifier node for the tag name. The tag-name node is an
  // Identifier (most common) or a PropertyAccessExpression (rare for
  // Route element, e.g. `Pages.Home`). Stick to the Identifier shape;
  // PropertyAccess gets a follow-up.
  const tagNameNode = (Node.isJsxOpeningElement(inner) || Node.isJsxSelfClosingElement(inner))
    ? inner.getTagNameNode()
    : Node.isJsxElement(inner) ? inner.getOpeningElement().getTagNameNode() : null;
  if (!tagNameNode || !Node.isIdentifier(tagNameNode)) return null;

  return resolveIdentifierToFunctionId(tagNameNode, ctx);
}

/**
 * Resolve an Identifier to a FunctionDefinition id by following the
 * symbol's first declaration. Mirrors `framework-react-native`'s
 * cross-file component resolution.
 */
function resolveIdentifierToFunctionId(
  identifier: TsNode,
  ctx: VisitorContext,
): string | null {
  if (!Node.isIdentifier(identifier)) return null;
  const symbol = identifier.getSymbol();
  if (!symbol) return null;
  const decls = symbol.getDeclarations();
  if (decls.length === 0) return null;
  const decl = decls[0];

  // Cross-file via import: walk up to the import declaration.
  if (Node.isImportSpecifier(decl) || Node.isImportClause(decl)) {
    return resolveCrossFileComponent(decl, identifier.getText(), ctx);
  }

  // Same-file: variable / function declaration with a function shape.
  const fnNode = unwrapToFunctionShape(decl);
  if (!fnNode) return null;
  const name = getFunctionName(decl, fnNode);
  if (!name) return null;
  return idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name,
    sourceLine: fnNode.getStartLineNumber(),
  });
}

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

  const isDefault = Node.isImportClause(importDecl);
  const exportName = isDefault ? 'default' : identifierName;
  const targetSymbol = targetFile.getExportedDeclarations().get(exportName);
  if (!targetSymbol || targetSymbol.length === 0) return null;

  const targetDecl = targetSymbol[0];
  const fnNode = unwrapToFunctionShape(targetDecl);
  if (!fnNode) return null;

  const name = getFunctionName(targetDecl, fnNode);
  if (!name) return null;

  return idFor.functionDefinition({
    sourceFileId: targetSourceFileId,
    name,
    sourceLine: fnNode.getStartLineNumber(),
  });
}

/**
 * Reduce a declaration node to its function-shaped node:
 *   - FunctionDeclaration: the declaration itself.
 *   - VariableDeclaration with arrow / function-expression initializer:
 *     the initializer.
 *   - Otherwise: null.
 */
function unwrapToFunctionShape(decl: TsNode): TsNode | null {
  if (Node.isFunctionDeclaration(decl) || Node.isFunctionExpression(decl) || Node.isArrowFunction(decl)) {
    return decl;
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
  }
  if (Node.isExportAssignment(decl)) {
    const expr = decl.getExpression();
    if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) return expr;
    if (Node.isIdentifier(expr)) {
      // Re-export: `export default Foo` — caller handles via symbol chain.
      return null;
    }
  }
  return null;
}

function getFunctionName(decl: TsNode, fnNode: TsNode): string | null {
  if (Node.isFunctionDeclaration(decl)) return decl.getName() ?? null;
  if (Node.isVariableDeclaration(decl)) return decl.getName();
  if (Node.isFunctionDeclaration(fnNode)) return fnNode.getName() ?? null;
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// <Link to="..."> → NAVIGATES_TO
// ──────────────────────────────────────────────────────────────────────

function emitLinkNavigation(
  linkElement: JsxOpeningElement | JsxSelfClosingElement,
  ctx: VisitorContext,
): void {
  if (!ctx.enclosingFunction) return;
  const target = getJsxAttributeStringValue(linkElement, 'to');
  if (target === null) return;
  // Skip relative paths and unresolvable shapes — react-router resolves
  // them against the current route at runtime, which we can't model
  // statically yet.
  if (!target.startsWith('/')) return;
  // Strip query string + fragment.
  let path = target;
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  const h = path.indexOf('#');
  if (h >= 0) path = path.slice(0, h);
  if (path === '') path = '/';

  const targetId = idFor.screen({
    repository: ctx.sourceFile.repository,
    name: path,
    routePath: path,
  });

  ctx.emitEdge({
    edgeType: 'NAVIGATES_TO',
    from: ctx.enclosingFunction.id,
    to: targetId,
    method: 'link',
    sourceLine: linkElement.getStartLineNumber(),
  } as NavigatesToEdge);
}

// ──────────────────────────────────────────────────────────────────────
// Round 7 — programmatic navigation: useNavigate() / redirect()
// ──────────────────────────────────────────────────────────────────────

/**
 * Emit a NAVIGATES_TO edge for a `navigate('/path', ...)` or
 * `redirect('/path')` call. Conservative: the first argument must be
 * a string literal (or no-substitution template) starting with `/`.
 * Computed paths are skipped.
 */
function emitProgrammaticNavigation(
  call: TsNode,
  ctx: VisitorContext,
  method: 'useNavigate' | 'redirect',
): void {
  if (!Node.isCallExpression(call)) return;
  if (!ctx.enclosingFunction) return;
  const args = call.getArguments();
  if (args.length === 0) return;
  const first = args[0];
  let target: string | null = null;
  if (Node.isStringLiteral(first)) target = first.getLiteralValue();
  else if (Node.isNoSubstitutionTemplateLiteral(first)) target = first.getLiteralValue();
  if (target === null) return;
  if (!target.startsWith('/')) return;

  // Strip query/fragment.
  let p = target;
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h >= 0) p = p.slice(0, h);
  if (p === '') p = '/';

  const targetId = idFor.screen({
    repository: ctx.sourceFile.repository,
    name: p,
    routePath: p,
  });

  const edge: NavigatesToEdge = {
    edgeType: 'NAVIGATES_TO',
    from: ctx.enclosingFunction.id,
    to: targetId,
    method,
    sourceLine: call.getStartLineNumber(),
  };
  ctx.emitEdge(edge);
}

/**
 * True iff the Identifier resolves to a `const x = useNavigate()`
 * binding in the same file. Symbol walk + initializer inspection;
 * no symbol-from-react-router check (rare for `useNavigate` to be
 * named anything else, and binding name is the only signal users
 * have).
 */
function isUseNavigateBinding(ident: TsNode): boolean {
  if (!Node.isIdentifier(ident)) return false;
  const sym = ident.getSymbol();
  if (!sym) return false;
  for (const d of sym.getDeclarations()) {
    if (!Node.isVariableDeclaration(d)) continue;
    const init = d.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const c = init.getExpression();
    if (Node.isIdentifier(c) && c.getText() === 'useNavigate') return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// JSX attribute helpers
// ──────────────────────────────────────────────────────────────────────

function getJsxAttribute(
  element: JsxOpeningElement | JsxSelfClosingElement,
  name: string,
): TsNode | undefined {
  const attrs = element.getAttributes();
  for (const attr of attrs) {
    if (Node.isJsxAttribute(attr)) {
      const nameNode = attr.getNameNode();
      if (Node.isIdentifier(nameNode) && nameNode.getText() === name) return attr;
    }
  }
  return undefined;
}

function getJsxAttributeStringValue(
  element: JsxOpeningElement | JsxSelfClosingElement,
  name: string,
): string | null {
  const attr = getJsxAttribute(element, name);
  if (!attr || !Node.isJsxAttribute(attr)) return null;
  const init = attr.getInitializer();
  if (!init) return null;
  if (Node.isStringLiteral(init)) return init.getLiteralValue();
  if (Node.isJsxExpression(init)) {
    const inner = init.getExpression();
    if (!inner) return null;
    if (Node.isStringLiteral(inner) || Node.isNoSubstitutionTemplateLiteral(inner)) {
      return inner.getLiteralValue();
    }
  }
  return null;
}
