import { Node, type CallExpression, type ObjectLiteralExpression, type Expression } from 'ts-morph';
import { idFor, type APIEndpoint } from '@adorable/schema';
import { recordConfidenceDecision } from '@adorable/observability';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  emitTemplateRenderScreens,
  resolveHandlerToFunctionId,
} from '@adorable/lang-ts';

/**
 * Hapi framework visitor (#27).
 *
 * Detects server-side API endpoints declared via `server.route()` and emits
 * canonical `APIEndpoint` nodes.
 *
 * Detection shape:
 *
 *   server.route({ method: 'GET', path: '/users/{id}', handler })
 *   server.route([
 *     { method: 'GET', path: '/', handler: h1 },
 *     { method: ['GET', 'POST'], path: '/multi', handler: h2 }
 *   ])
 *
 * Hapi path parameters use `{param}` syntax which is normalized to `:param`
 * for consistency with Express-style patterns.
 *
 * The receiver must match `/^(this\.)?server$/` (conservative heuristic).
 *
 * Handler resolution uses the shared `resolveHandlerToFunctionId`
 * utility from `@adorable/lang-ts`, including cross-file resolution.
 */

const RECEIVER_NAME_PATTERN = /^(this\.)?server$/;

export function createHapiVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      if (callee.getNameNode().getText() !== 'route') return;

      const receiver = callee.getExpression();
      if (!RECEIVER_NAME_PATTERN.test(receiver.getText())) return;

      const args = node.getArguments();
      if (args.length === 0) return;

      const arg = args[0];

      // Single route object
      if (Node.isObjectLiteralExpression(arg)) {
        emitRouteFromObject(arg, node, ctx);
        return;
      }

      // Array of route objects
      if (Node.isArrayLiteralExpression(arg)) {
        for (const element of arg.getElements()) {
          if (Node.isObjectLiteralExpression(element)) {
            emitRouteFromObject(element, node, ctx);
          }
        }
        return;
      }
    },
  };
}

/**
 * Extract route info from a Hapi route config object and emit APIEndpoint nodes.
 *
 * A single config may produce multiple endpoints if `method` is an array:
 *   { method: ['GET', 'POST'], path: '/users', handler }
 */
function emitRouteFromObject(
  obj: ObjectLiteralExpression,
  call: CallExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0]
): void {
  const pathProp = obj.getProperty('path');
  const methodProp = obj.getProperty('method');
  const handlerProp = obj.getProperty('handler');

  if (!pathProp || !methodProp) return;

  // Extract path
  if (!Node.isPropertyAssignment(pathProp)) return;
  const pathInit = pathProp.getInitializer();
  if (!pathInit || (!Node.isStringLiteral(pathInit) && !Node.isNoSubstitutionTemplateLiteral(pathInit))) {
    recordConfidenceDecision('hapi route path is not a string literal', {
      'call.sourceLine': call.getStartLineNumber(),
    });
    return;
  }
  const rawPath = pathInit.getLiteralValue();
  // Normalize Hapi {param} to :param
  const routePattern = rawPath.replace(/\{(\w+)(\?)?(\*\d*)?\}/g, ':$1');

  // Extract method(s)
  if (!Node.isPropertyAssignment(methodProp)) return;
  const methodInit = methodProp.getInitializer();
  if (!methodInit) return;

  const methods: string[] = [];
  if (Node.isStringLiteral(methodInit) || Node.isNoSubstitutionTemplateLiteral(methodInit)) {
    methods.push(methodInit.getLiteralValue().toUpperCase());
  } else if (Node.isArrayLiteralExpression(methodInit)) {
    for (const el of methodInit.getElements()) {
      if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
        methods.push(el.getLiteralValue().toUpperCase());
      }
    }
  } else {
    recordConfidenceDecision('hapi route method is not a string or array literal', {
      'call.sourceLine': call.getStartLineNumber(),
    });
    return;
  }

  // Resolve handler using shared utility (supports cross-file resolution)
  let handlerFunctionId: string | null = null;
  if (handlerProp && Node.isPropertyAssignment(handlerProp)) {
    const handlerInit = handlerProp.getInitializer();
    if (handlerInit) {
      handlerFunctionId = resolveHandlerToFunctionId(handlerInit, call, ctx, 'hapi');
    }
  }

  const evidence = buildEvidence(obj, ctx.sourceFile.filePath);
  for (const httpMethod of methods) {
    const endpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository: ctx.sourceFile.repository,
        httpMethod,
        routePattern,
        filePath: evidence.filePath,
        lineStart: evidence.lineStart,
      }),
      httpMethod,
      routePattern,
      handlerFunctionId,
      framework: 'hapi',
      repository: ctx.sourceFile.repository,
      evidence,
    };
    ctx.emitNode(endpoint);

    // Round 7 — Hapi server-side template render: `h.view('foo')`.
    if (handlerProp && Node.isPropertyAssignment(handlerProp)) {
      const handlerInit = handlerProp.getInitializer();
      if (handlerInit) {
        emitTemplateRenderScreens(handlerInit, endpoint.id, ctx, HAPI_RENDER_CONFIG);
      }
    }
  }
}

const HAPI_RENDER_CONFIG = {
  framework: 'hapi-ssr',
  receiverNames: new Set(['h', 'response', 'toolkit']),
  methodNames: new Set(['view']),
};
