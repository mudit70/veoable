import { Node, type CallExpression, type Expression, type Node as TsNode } from 'ts-morph';
import { idFor, type APIEndpoint, type MiddlewareEntry } from '@veoable/schema';
import { recordConfidenceDecision } from '@veoable/observability';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  emitTemplateRenderScreens,
  resolveHandlerToFunctionId,
  resolveToString,
} from '@veoable/lang-ts';

/**
 * Koa framework visitor (#27).
 *
 * Detects server-side API endpoints declared via koa-router / @koa/router
 * and emits canonical `APIEndpoint` nodes.
 *
 * Detection shape:
 *
 *   router.<method>('/path', handler)
 *   router.<method>('name', '/path', handler)   // named route
 *
 * where `<method>` is one of the standard HTTP verbs.
 *
 * The receiver identifier must match `/^(this\.)?router$/` (conservative
 * heuristic).
 *
 * Named routes (first arg is a name string, second is the path) are
 * supported — the name is ignored, the path is used.
 *
 * Known gap: prefix composition via `new Router({ prefix: '/api' })` is
 * NOT applied here — routes are emitted as declared on the router. This
 * is the same limitation as Express (`app.use('/api', router)`).
 * Prefix composition is deferred to the flow stitcher (#4).
 *
 * Handler resolution uses the shared `resolveHandlerToFunctionId`
 * utility from `@veoable/lang-ts`.
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

const RECEIVER_NAME_PATTERN = /^(this\.)?router$/;

export function createKoaVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      const classification = classifyRouteCall(node);
      if (!classification) return;

      const { httpMethod, routePattern, handlerExpr, middlewareExprs } = classification;

      const handlerFunctionId = resolveHandlerToFunctionId(handlerExpr, node, ctx, 'koa');

      const middlewareChain: MiddlewareEntry[] = middlewareExprs.map((mwExpr, i) => {
        const name = Node.isIdentifier(mwExpr) ? mwExpr.getText()
          : Node.isCallExpression(mwExpr) ? mwExpr.getExpression().getText()
          : '<anonymous>';
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
        framework: 'koa',
        repository: ctx.sourceFile.repository,
        evidence,
        ...(middlewareChain.length > 0 ? { middlewareChain } : {}),
      };
      ctx.emitNode(endpoint);

      // Round 7 — Koa server-side template render: `ctx.render('foo')`.
      emitTemplateRenderScreens(handlerExpr, endpoint.id, ctx, KOA_RENDER_CONFIG);
    },
  };
}

const KOA_RENDER_CONFIG = {
  framework: 'koa-ssr',
  receiverNames: new Set(['ctx', 'context']),
  methodNames: new Set(['render']),
};

// ──────────────────────────────────────────────────────────────────────
// Call classification
// ──────────────────────────────────────────────────────────────────────

interface RouteClassification {
  httpMethod: string;
  routePattern: string;
  handlerExpr: Expression;
  middlewareExprs: Expression[];
}

/**
 * Decide whether a `CallExpression` is a koa-router route declaration.
 *
 * Koa-router supports two forms:
 *   router.get('/path', handler)             — standard
 *   router.get('name', '/path', handler)     — named route
 *
 * Named routes have 3+ args where first two are string literals.
 */
function classifyRouteCall(call: CallExpression): RouteClassification | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;

  const method = callee.getNameNode().getText();
  if (!HTTP_METHODS.has(method)) return null;

  const receiver = callee.getExpression();
  const receiverText = receiver.getText();
  if (!RECEIVER_NAME_PATTERN.test(receiverText)) return null;

  const args = call.getArguments();
  if (args.length < 2) return null;

  // Determine if this is a named route: router.get('name', '/path', ...)
  let pathArgIndex = 0;
  if (
    args.length >= 3 &&
    isStringLiteral(args[0]) &&
    isStringLiteral(args[1])
  ) {
    const secondVal = getStringValue(args[1]);
    if (secondVal !== null && secondVal.startsWith('/')) {
      pathArgIndex = 1;
    }
  }

  const pathArg = args[pathArgIndex];
  let routePattern: string;
  if (isStringLiteral(pathArg)) {
    routePattern = getStringValue(pathArg)!;
  } else {
    // #193: try the widened lang-ts resolver for computed paths.
    const resolved = resolveToString(pathArg);
    if (resolved === null) {
      recordConfidenceDecision('koa route path is not a string literal', {
        'koa.method': method,
        'call.sourceLine': call.getStartLineNumber(),
      });
      return null;
    }
    routePattern = resolved;
  }

  const handlerExpr = args[args.length - 1] as Expression;
  const middlewareExprs = args.slice(pathArgIndex + 1, -1) as Expression[];

  return { httpMethod: method, routePattern, handlerExpr, middlewareExprs };
}

function isStringLiteral(node: TsNode): boolean {
  return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node);
}

function getStringValue(node: TsNode): string | null {
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return null;
}
