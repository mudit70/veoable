import { Node, type CallExpression, type Expression } from 'ts-morph';
import { idFor, type APIEndpoint, type MiddlewareEntry } from '@adorable/schema';
import { recordConfidenceDecision } from '@adorable/observability';
import {
  type TsFrameworkVisitor,
  type TsVisitContext,
  buildEvidence,
  emitTemplateRenderScreens,
  resolveHandlerToFunctionId,
  resolveToString,
} from '@adorable/lang-ts';
import { classifyExpressReceiver } from './resolve-receiver.js';
import { emitDispatcherEndpoints, matchDispatcher } from './dispatcher.js';

/**
 * Express framework visitor (#15, #180).
 *
 * Detects server-side API endpoints declared via the Express routing
 * API and emits canonical `APIEndpoint` nodes for them.
 *
 * Detection shape:
 *
 *   <routable>.<method>('/path', handler)
 *
 * where `<routable>` is any expression whose value is an Express
 * `Application` (created by `express()`) or `Router` (created by
 * `Router()` / `express.Router()`), regardless of the binding name.
 * The classifier traces variables, class fields, and imports back to
 * the originating factory call (see `./resolve-receiver.ts`).
 *
 * `<method>` is one of the standard Express routing verbs: `get`,
 * `post`, `put`, `delete`, `patch`, `head`, `options`, or `all`.
 *
 * Handler resolution uses the shared `resolveHandlerToFunctionId`
 * utility from `@adorable/lang-ts`.
 *
 * Route pattern:
 *
 *   - Must be a `StringLiteral` or `NoSubstitutionTemplateLiteral`.
 *     Computed paths (`app.get(PATHS.users, ...)`) are skipped with
 *     a `ConfidenceDecision` event.
 *   - Path mounting via `app.use('/api', router)` is NOT composed
 *     here — routes are emitted as declared on whichever router
 *     owns them. Composition is future work for the flow stitcher
 *     (#4).
 *
 * Identity:
 *
 *   - `APIEndpoint.id` is content-addressed on
 *     `(repository, httpMethod, routePattern)`, so two declarations
 *     of the same endpoint (in different files, or after a
 *     harmless refactor) collapse at commit time.
 */

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'all',
]);

export function createExpressVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      const classification = classifyRouteCall(node);
      if (!classification) return;

      const { httpMethod, routePattern, handlerExpr, middlewareExprs, receiverText, receiverKind } =
        classification;

      // Record receivers that aren't the canonical app/router names —
      // useful for telemetry (we want to know how often AST-based
      // resolution catches calls the old name heuristic missed).
      if (receiverText !== 'app' && receiverText !== 'router') {
        recordConfidenceDecision('express receiver matched by AST resolution', {
          'express.receiver': receiverText,
          'express.receiverKind': receiverKind,
          'express.method': httpMethod,
          'call.sourceLine': node.getStartLineNumber(),
        });
      }

      const handlerFunctionId = resolveHandlerToFunctionId(handlerExpr, node, ctx, 'express');

      // Extract middleware chain (#140).
      const middlewareChain: MiddlewareEntry[] = middlewareExprs.map((mwExpr, i) => {
        const name = nameForMiddlewareExpression(mwExpr);
        return { functionId: null, name, order: i };
      });

      const evidence = buildEvidence(node, ctx.sourceFile.filePath);
      const endpoint: APIEndpoint = {
        nodeType: 'APIEndpoint',
        id: idFor.apiEndpoint({
          repository: ctx.sourceFile.repository,
          httpMethod: httpMethod.toUpperCase(),
          routePattern,
          filePath: evidence.filePath,
          lineStart: evidence.lineStart,
        }),
        httpMethod: httpMethod.toUpperCase(),
        routePattern,
        handlerFunctionId,
        framework: 'express',
        repository: ctx.sourceFile.repository,
        evidence,
        ...(middlewareChain.length > 0 ? { middlewareChain } : {}),
      };
      ctx.emitNode(endpoint);

      // #194 — request-name dispatcher expansion. If `handlerExpr` is
      // a `<wrapper>(<objLit>)` call where the wrapper's body
      // dispatches on a request field, emit one extra APIEndpoint
      // per object-literal key. Only fires when both signals match
      // (Signal 1 + Signal 2). Logs the expansion to ConfidenceDecision
      // observability so users can spot-check.
      const dispatch = matchDispatcher(handlerExpr);
      if (dispatch) {
        const subEndpoints = emitDispatcherEndpoints(
          node,
          routePattern,
          httpMethod,
          dispatch,
          ctx,
        );
        for (const subEp of subEndpoints) {
          ctx.emitNode(subEp);
        }
        recordConfidenceDecision('express dispatcher expansion', {
          'express.basePath': routePattern,
          'express.paramName': dispatch.paramName,
          'express.source': dispatch.source,
          'express.subEndpointCount': subEndpoints.length,
          'call.sourceLine': node.getStartLineNumber(),
        });
      }

      // #198 PR3b + Round 7 — `res.render('template')` server-side
      // rendering. Walk the handler's body (inline OR cross-file
      // resolved via the type-checker-first helper) for top-level
      // render calls and emit a Screen + RENDERS edge per match.
      emitTemplateRenderScreens(handlerExpr, endpoint.id, ctx, EXPRESS_RENDER_CONFIG);
    },
  };
}

const EXPRESS_RENDER_CONFIG = {
  framework: 'express-ssr',
  receiverNames: new Set(['res', 'response', 'reply']),
  methodNames: new Set(['render']),
  // Round 7 — wrapped-send shape: `res.send(nunjucks.render('foo'))`.
  wrappedSend: {
    outerReceivers: new Set(['res', 'response', 'reply']),
    outerMethods: new Set(['send', 'end', 'write']),
    innerReceivers: new Set(['nunjucks', 'pug', 'mustache', 'ejs', 'handlebars', 'Mustache']),
    innerMethods: new Set(['render', 'renderString', 'renderFile']),
  },
};

// (express's res.render Screen + RENDERS edge logic now lives in
// `@adorable/lang-ts`'s `emitTemplateRenderScreens` and is shared
// with framework-koa, framework-hapi, framework-hono.)

// ──────────────────────────────────────────────────────────────────────
// Call classification
// ──────────────────────────────────────────────────────────────────────

interface RouteClassification {
  httpMethod: string;
  routePattern: string;
  handlerExpr: Expression;
  middlewareExprs: Expression[];
  receiverText: string;
  receiverKind: 'app' | 'router';
}

/**
 * Decide whether a `CallExpression` is an Express route declaration.
 * Returns the extracted method/path/handler on success, or `null`
 * if the shape doesn't match.
 */
function classifyRouteCall(call: CallExpression): RouteClassification | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;

  const method = callee.getNameNode().getText();
  if (!HTTP_METHODS.has(method)) return null;

  const receiver = callee.getExpression();
  const receiverText = receiver.getText();
  const receiverKind = classifyExpressReceiver(receiver);
  if (receiverKind === 'unknown') return null;

  const args = call.getArguments();
  if (args.length < 2) return null;

  const pathArg = args[0];
  let routePattern: string;
  if (Node.isStringLiteral(pathArg) || Node.isNoSubstitutionTemplateLiteral(pathArg)) {
    routePattern = pathArg.getLiteralValue();
  } else {
    // Computed path — try the widened resolver (#193). Handles
    // imported constants (`vars.jade.bundleDownloadUrl`), pure-function
    // helpers (`getSdkDocPageExpressRouteExpression(prefix)`), and
    // string concatenation chains.
    const resolved = resolveToString(pathArg);
    if (resolved === null) {
      recordConfidenceDecision('express route path is not a string literal', {
        'express.method': method,
        'call.sourceLine': call.getStartLineNumber(),
      });
      return null;
    }
    routePattern = resolved;
  }

  const handlerExpr = args[args.length - 1] as Expression;
  const middlewareExprs = args.slice(1, -1) as Expression[];

  return {
    httpMethod: method,
    routePattern,
    handlerExpr,
    middlewareExprs,
    receiverText,
    receiverKind,
  };
}

/**
 * #127 — name a middleware expression for the MiddlewareEntry chain.
 *
 * Bare Identifier   → `auth`
 * PropertyAccess    → `passport.authenticate`
 * CallExpression    → `<callee>` plus a `(<arg>)` suffix when the first
 *                     argument is a string literal (so
 *                     `passport.authenticate('jwt')` becomes
 *                     `passport.authenticate('jwt')` — surfaces the
 *                     Passport strategy name).
 *
 * Anonymous arrow / function expressions → `<anonymous>`.
 */
function nameForMiddlewareExpression(mwExpr: Node): string {
  if (Node.isIdentifier(mwExpr)) return mwExpr.getText();
  if (Node.isPropertyAccessExpression(mwExpr)) return mwExpr.getText();
  if (Node.isCallExpression(mwExpr)) {
    const callee = mwExpr.getExpression();
    let calleeText = '<anonymous>';
    if (Node.isIdentifier(callee)) calleeText = callee.getText();
    else if (Node.isPropertyAccessExpression(callee)) calleeText = callee.getText();
    const args = mwExpr.getArguments();
    if (args.length > 0) {
      const first = args[0];
      let strArg: string | null = null;
      if (Node.isStringLiteral(first)) strArg = first.getLiteralValue();
      else if (Node.isNoSubstitutionTemplateLiteral(first)) strArg = first.getLiteralValue();
      if (strArg !== null) return `${calleeText}('${strArg}')`;
    }
    return calleeText;
  }
  return '<anonymous>';
}
