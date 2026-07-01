import { Node, type CallExpression, type Expression } from 'ts-morph';
import { idFor, type APIEndpoint, type MiddlewareEntry } from '@adorable/schema';
import { recordConfidenceDecision } from '@adorable/observability';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  emitTemplateRenderScreens,
  resolveHandlerToFunctionId,
  resolveToString,
} from '@adorable/lang-ts';

/**
 * Hono framework visitor (#31).
 *
 * Detects server-side API endpoints declared via Hono's routing API
 * and emits canonical `APIEndpoint` nodes.
 *
 * Detection shape (similar to Express):
 *
 *   app.<method>('/path', handler)
 *   app.<method>('/path', middleware, handler)
 *
 * Hono also supports path parameters with `:param` syntax (same as Express)
 * and wildcards with `*`.
 *
 * The receiver identifier must match `/^(this\.)?app$/` (conservative
 * heuristic). To avoid collisions with Express (which also matches `app`),
 * the visitor additionally checks that `Hono` is imported in the current
 * source file.
 *
 * Note: `app.use('/path', middleware)` is intentionally NOT detected as
 * an endpoint — it registers middleware, not a route handler. This is
 * the same as Express.
 *
 * Handler resolution uses the shared `resolveHandlerToFunctionId`
 * utility from `@adorable/lang-ts`.
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

const RECEIVER_NAME_PATTERN = /^(this\.)?app$/;

export function createHonoVisitor(): TsFrameworkVisitor {
  // Cache per-file Hono import check
  const fileHonoImportCache = new Map<string, boolean>();

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      // M1 fix: Only match if the file imports from 'hono'.
      if (!fileImportsHono(node, ctx.sourceFile.filePath, fileHonoImportCache)) return;

      const classification = classifyRouteCall(node);
      if (!classification) return;

      const { httpMethod, routePattern, handlerExpr, middlewareExprs } = classification;

      const handlerFunctionId = resolveHandlerToFunctionId(handlerExpr, node, ctx, 'hono');

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
        framework: 'hono',
        repository: ctx.sourceFile.repository,
        evidence,
        ...(middlewareChain.length > 0 ? { middlewareChain } : {}),
      };
      ctx.emitNode(endpoint);

      // Round 7 — Hono server-side template render: `c.render('foo')`
      // when a renderer middleware is configured. `c.html(...)`
      // intentionally excluded — it takes JSX or raw strings, not a
      // template name.
      emitTemplateRenderScreens(handlerExpr, endpoint.id, ctx, HONO_RENDER_CONFIG);
    },
  };
}

const HONO_RENDER_CONFIG = {
  framework: 'hono-ssr',
  receiverNames: new Set(['c', 'ctx', 'context']),
  methodNames: new Set(['render']),
};

// ──────────────────────────────────────────────────────────────────────
// Import-aware heuristic (M1)
// ──────────────────────────────────────────────────────────────────────

/**
 * Check if the source file containing `node` imports `Hono`.
 * This prevents collisions with Express which also matches `app.*()`.
 *
 * Checks two signals:
 *   1. The file imports from 'hono' or 'hono/*'
 *   2. The file imports a named binding called `Hono`
 *
 * Signal (2) also covers test stubs that re-export a `Hono` constructor
 * from a local file.
 */
function fileImportsHono(
  node: Node,
  filePath: string,
  cache: Map<string, boolean>,
): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;

  const sourceFile = node.getSourceFile();
  const importDecls = sourceFile.getImportDeclarations();
  const hasHono = importDecls.some((d) => {
    // Signal 1: module specifier is 'hono' or 'hono/*'
    const specifier = d.getModuleSpecifierValue();
    if (specifier === 'hono' || specifier.startsWith('hono/')) return true;
    // Signal 2: a named import called 'Hono'
    const namedImports = d.getNamedImports();
    return namedImports.some((n) => n.getName() === 'Hono');
  });

  cache.set(filePath, hasHono);
  return hasHono;
}

// ──────────────────────────────────────────────────────────────────────
// Call classification
// ──────────────────────────────────────────────────────────────────────

interface RouteClassification {
  httpMethod: string;
  routePattern: string;
  handlerExpr: Expression;
  middlewareExprs: Expression[];
}

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

  const pathArg = args[0];
  let routePattern: string;
  if (Node.isStringLiteral(pathArg) || Node.isNoSubstitutionTemplateLiteral(pathArg)) {
    routePattern = pathArg.getLiteralValue();
  } else {
    // #193: try the widened lang-ts resolver for computed paths.
    const resolved = resolveToString(pathArg);
    if (resolved === null) {
      recordConfidenceDecision('hono route path is not a string literal', {
        'hono.method': method,
        'call.sourceLine': call.getStartLineNumber(),
      });
      return null;
    }
    routePattern = resolved;
  }

  const handlerExpr = args[args.length - 1] as Expression;
  const middlewareExprs = args.slice(1, -1) as Expression[];

  return { httpMethod: method, routePattern, handlerExpr, middlewareExprs };
}
