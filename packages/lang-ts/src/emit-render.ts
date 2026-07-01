import { Node, SyntaxKind, type Expression } from 'ts-morph';
import { idFor, type RendersEdge, type Screen } from '@veoable/schema';
import { recordConfidenceDecision } from '@veoable/observability';
import type { TsVisitContext } from './framework-visitor.js';
import { resolveToString } from './resolve-constant.js';
import { resolveIdentifierTypeToDeclaration } from './cross-file-resolver.js';

/**
 * Shared template-render extractor (#198 PR3b + Round 7 Koa/Hapi/Hono).
 *
 * Multiple HTTP framework visitors (Express, Koa, Hapi, Hono, ...)
 * have identical RENDERS-edge emission logic at the body-walk level —
 * the only differences are:
 *   - which receiver names count as the response-like object
 *     (`res` for Express, `ctx` for Koa, `h` for Hapi, `c` for Hono);
 *   - which method name(s) on that receiver triggers a render emission
 *     (`render` for Express/Koa/Hono, `view` for Hapi);
 *   - the framework label written into the emitted Screen.
 *
 * `emitTemplateRenderScreens` factors that loop. Call it from each
 * framework visitor right after the APIEndpoint is emitted, with the
 * framework's specific receiver / method config.
 */
export interface EmitRenderConfig {
  /** Framework label written into Screen.framework (e.g., 'express-ssr'). */
  readonly framework: string;
  /** Identifier names accepted as the render receiver (e.g., 'res', 'response', 'reply'). */
  readonly receiverNames: ReadonlySet<string>;
  /** Method names on the receiver that produce a render (e.g., 'render', 'view'). */
  readonly methodNames: ReadonlySet<string>;
  /**
   * Round 7 — also detect wrapped-send shapes:
   *   `res.send(nunjucks.render('foo.njk', { ... }))`
   *
   * When set, look for CallExpressions whose form is
   *   `<sendReceiver>.<sendMethod>(<libReceiver>.<libMethod>(<template>, ...))`
   * and emit a Screen + RENDERS edge for the inner template.
   *
   * Optional. Frameworks that don't have this idiom can omit it.
   */
  readonly wrappedSend?: {
    /** Outer-call receiver names (e.g., 'res', 'response'). */
    readonly outerReceivers: ReadonlySet<string>;
    /** Outer-call method names (e.g., 'send', 'end'). */
    readonly outerMethods: ReadonlySet<string>;
    /** Inner template-render libraries (e.g., 'nunjucks', 'pug', 'mustache', 'ejs', 'handlebars'). */
    readonly innerReceivers: ReadonlySet<string>;
    /** Inner library method names that return rendered HTML (e.g.,
     *  'render', 'renderString', 'renderFile'). NOTE: `compile`-style
     *  factories return a function, not HTML, so they are not included. */
    readonly innerMethods: ReadonlySet<string>;
  };
}

/**
 * Walk the inline arrow / function-expression handler body for top-level
 * `<receiver>.<method>(<template>, ...)` calls. For each call where
 *   - the receiver is an Identifier in `receiverNames`,
 *   - the method matches one of `methodNames`,
 *   - the first argument is a string literal or static-resolvable
 *     constant,
 * emit a Screen + RENDERS edge from `endpointId` to the Screen.
 *
 * Cross-file handlers — when `handlerExpr` is an Identifier (e.g.,
 * `app.get('/x', someHandler)`), resolve it via the type-checker-first
 * helper from #200 and walk the resolved function body. Declarations
 * in `node_modules` / `.d.ts` are skipped to avoid phantom Screens
 * from third-party middleware.
 */
export function emitTemplateRenderScreens(
  handlerExpr: Expression,
  endpointId: string,
  ctx: TsVisitContext,
  config: EmitRenderConfig,
): void {
  // Round 7 — when the handler is an Identifier referring to a
  // function declared elsewhere, resolve it cross-file via the
  // type-checker-first helper and walk that function's body.
  let body = getInlineHandlerBody(handlerExpr);
  if (!body && Node.isIdentifier(handlerExpr)) {
    body = resolveIdentifierToFunctionBody(handlerExpr);
  }
  if (!body) return;

  const calls: Node[] = Node.isCallExpression(body)
    ? [body, ...body.getDescendantsOfKind(SyntaxKind.CallExpression)]
    : body.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const callRaw of calls) {
    if (!Node.isCallExpression(callRaw)) continue;
    const callee = callRaw.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;

    const methodText = callee.getNameNode().getText();
    const receiverNode = callee.getExpression();
    if (!Node.isIdentifier(receiverNode)) continue;
    const receiverText = receiverNode.getText();

    let templateName: string | null = null;
    let templateExprForLine: Node = callRaw;

    // Direct form: `<res>.render('foo')`.
    const directMatch =
      config.methodNames.has(methodText) && config.receiverNames.has(receiverText);
    if (directMatch) {
      const args = callRaw.getArguments();
      if (args.length === 0) continue;
      const firstArg = args[0];
      if (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg)) {
        templateName = firstArg.getLiteralValue();
      } else {
        templateName = resolveToString(firstArg);
      }
    } else if (
      // Wrapped-send form: `<res>.send(<lib>.render('foo', ...))`.
      config.wrappedSend &&
      config.wrappedSend.outerMethods.has(methodText) &&
      config.wrappedSend.outerReceivers.has(receiverText)
    ) {
      const args = callRaw.getArguments();
      if (args.length === 0) continue;
      const inner = args[0];
      if (!Node.isCallExpression(inner)) continue;
      const innerCallee = inner.getExpression();
      if (!Node.isPropertyAccessExpression(innerCallee)) continue;
      const innerMethod = innerCallee.getNameNode().getText();
      if (!config.wrappedSend.innerMethods.has(innerMethod)) continue;
      const innerReceiver = innerCallee.getExpression();
      if (!Node.isIdentifier(innerReceiver)) continue;
      if (!config.wrappedSend.innerReceivers.has(innerReceiver.getText())) continue;

      const innerArgs = inner.getArguments();
      if (innerArgs.length === 0) continue;
      const tmpl = innerArgs[0];
      if (Node.isStringLiteral(tmpl) || Node.isNoSubstitutionTemplateLiteral(tmpl)) {
        templateName = tmpl.getLiteralValue();
      } else {
        templateName = resolveToString(tmpl);
      }
      templateExprForLine = inner;
    } else {
      continue;
    }

    if (templateName === null) {
      recordConfidenceDecision(`${config.framework} render template name not statically resolvable`, {
        [`${config.framework}.endpointId`]: endpointId,
        'call.sourceLine': callRaw.getStartLineNumber(),
      });
      continue;
    }

    const screenId = idFor.screen({
      repository: ctx.sourceFile.repository,
      name: templateName,
      routePath: null,
    });

    const screen: Screen = {
      nodeType: 'Screen',
      id: screenId,
      name: templateName,
      componentFunctionId: null,
      navigatorKind: undefined,
      routePath: null,
      sourceFileId: ctx.sourceFile.id,
      sourceLine: templateExprForLine.getStartLineNumber(),
      framework: config.framework,
      repository: ctx.sourceFile.repository,
    };
    ctx.emitNode(screen);

    const edge: RendersEdge = {
      edgeType: 'RENDERS',
      from: endpointId,
      to: screenId,
      templateName,
      sourceLine: templateExprForLine.getStartLineNumber(),
    };
    ctx.emitEdge(edge);
  }
}

function getInlineHandlerBody(handlerExpr: Expression): Node | null {
  if (Node.isArrowFunction(handlerExpr) || Node.isFunctionExpression(handlerExpr)) {
    return handlerExpr.getBody();
  }
  return null;
}

/**
 * Round 7 — cross-file handler walk: resolve a route-handler
 * Identifier (`app.get('/x', someHandler)`) to its function-shaped
 * declaration via the type-checker-first helper and return its body.
 *
 * Skips:
 *   - declarations in node_modules / .d.ts (Express middleware
 *     factories, third-party handlers — never legitimate render
 *     sites in user code).
 *   - function declarations without a body (overload signatures).
 *
 * Returns null when no resolution succeeds.
 */
function resolveIdentifierToFunctionBody(ident: Expression): Node | null {
  if (!Node.isIdentifier(ident)) return null;
  const decl = resolveIdentifierTypeToDeclaration(ident, (d) => {
    if (Node.isFunctionDeclaration(d)) return d.hasBody();
    if (Node.isVariableDeclaration(d)) {
      const init = d.getInitializer();
      return !!init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
    }
    return false;
  });
  if (!decl) return null;
  const sf = decl.getSourceFile();
  if (sf.isInNodeModules() || sf.isFromExternalLibrary()) return null;

  if (Node.isFunctionDeclaration(decl)) return decl.getBody() ?? null;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init.getBody();
    }
  }
  return null;
}
