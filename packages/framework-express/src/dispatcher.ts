import {
  Node,
  type CallExpression,
  type Expression,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type FunctionLikeDeclaration,
} from 'ts-morph';
import { idFor, type APIEndpoint } from '@adorable/schema';
import {
  type TsVisitContext,
  buildEvidence,
  resolveIdentifierTypeToDeclaration,
  resolveHandlerToFunctionId,
} from '@adorable/lang-ts';

/**
 * Express request-name dispatcher detection (#194).
 *
 * Recognizes the pattern:
 *
 *   app.post('/api/jade', handleAPIRequest({
 *     GetComputers:  initializeGetComputers(),
 *     CreateComputer: initializeCreateComputer(),
 *   }));
 *
 * where `handleAPIRequest` is a wrapper whose body dispatches on a
 * request field:
 *
 *   function handleAPIRequest(handlers) {
 *     return (req, res) => handlers[req.query.r](req, res);
 *   }
 *
 * For each match, emits one extra APIEndpoint per object-literal key
 * with `routePattern: <basePath>?<paramName>=<key>` (or
 * `<basePath>/<key>` for `params`-source dispatchers).
 *
 * Two-signal design (per the issue):
 *   - **Signal 1** — call-shape: `<wrapper>(<objLit>)` where every
 *     value is a route-handler-shaped expression.
 *   - **Signal 2** — wrapper body verification: the wrapper's body
 *     must contain `<X>[<reqParam>.<source>.<key>](<args>)` where
 *     `<X>` resolves back (through aliases / rest-spread) to the
 *     wrapper's first parameter.
 *
 * Default-ON; conservative bias — both signals must match. Signal 2
 * is the safety net that rejects validate({...}), auth({...}), etc.
 */

/** Sources that count as request-field dispatch. */
const REQ_SOURCES: ReadonlySet<string> = new Set(['query', 'body', 'params', 'headers']);

interface DispatcherMatch {
  /** Names of properties on the handler-map object literal. */
  keys: string[];
  /** Property name on the request used as dispatch key (`r`, `action`, `cmd`, ...). */
  paramName: string;
  /** Source of the dispatch field (`query`, `body`, `params`, `headers`). */
  source: 'query' | 'body' | 'params' | 'headers';
  /** The handler-map ObjectLiteralExpression — used to read per-key handler exprs. */
  handlerMap: ObjectLiteralExpression;
}

/**
 * Try to match `outerArg = wrapper(<objLit>)` as a dispatcher and
 * verify Signal 2 by walking the wrapper's body.
 *
 * Returns null when:
 *   - The argument doesn't have the `<wrapper>(<objLit>)` shape.
 *   - The wrapper's body doesn't contain a handler-map indexed call
 *     with a request-field key.
 */
export function matchDispatcher(outerArg: Expression): DispatcherMatch | null {
  if (!Node.isCallExpression(outerArg)) return null;
  const wrapperCallee = outerArg.getExpression();
  if (!Node.isIdentifier(wrapperCallee)) return null;

  const wrapperArgs = outerArg.getArguments();
  if (wrapperArgs.length === 0) return null;
  const handlerMap = wrapperArgs[0];
  if (!Node.isObjectLiteralExpression(handlerMap)) return null;

  // Signal 1: every property value must be route-handler-shaped:
  // CallExpression (`initializeFoo()`), Identifier, ArrowFunction,
  // or FunctionExpression. Reject objects whose values look like
  // option-bag entries (booleans, strings, plain arrays, etc.).
  const keys: string[] = [];
  for (const prop of handlerMap.getProperties()) {
    if (!Node.isPropertyAssignment(prop) && !Node.isShorthandPropertyAssignment(prop)) return null;
    const nameNode = prop.getNameNode();
    let key: string | null = null;
    if (Node.isIdentifier(nameNode)) key = nameNode.getText();
    else if (Node.isStringLiteral(nameNode)) key = nameNode.getLiteralValue();
    if (!key) return null;
    keys.push(key);
    if (Node.isPropertyAssignment(prop)) {
      const value = prop.getInitializer();
      if (!value) return null;
      if (
        !Node.isCallExpression(value) &&
        !Node.isIdentifier(value) &&
        !Node.isArrowFunction(value) &&
        !Node.isFunctionExpression(value)
      ) return null;
    }
  }
  if (keys.length === 0) return null;

  // Signal 2: resolve the wrapper to its declaration and verify
  // body shape: `<paramAlias>[req.<source>.<paramName>](req, res)`.
  const wrapperDecl = resolveIdentifierTypeToDeclaration(wrapperCallee, (d) => {
    if (Node.isFunctionDeclaration(d)) return d.hasBody();
    if (Node.isVariableDeclaration(d)) {
      const init = d.getInitializer();
      return !!init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
    }
    return false;
  });
  if (!wrapperDecl) return null;

  const fnNode = unwrapToFunctionLike(wrapperDecl);
  if (!fnNode) return null;

  const sf = fnNode.getSourceFile();
  if (sf.isInNodeModules() || sf.isFromExternalLibrary()) return null;

  // The wrapper's first parameter is the handler-map binding (sometimes
  // destructured via rest-spread).
  const params = fnNode.getParameters();
  if (params.length === 0) return null;
  const handlerMapParam = params[0];

  const sig = scanWrapperBodyForDispatch(fnNode, handlerMapParam);
  if (!sig) return null;

  return {
    keys,
    paramName: sig.paramName,
    source: sig.source,
    handlerMap,
  };
}

interface DispatchSignature {
  source: 'query' | 'body' | 'params' | 'headers';
  paramName: string;
}

/**
 * Walk the wrapper function's body for `<X>[<req>.<source>.<key>](<args>)`
 * call expressions where `<X>` resolves to the handler-map parameter
 * (directly, via local alias, or via rest-spread destructure).
 */
function scanWrapperBodyForDispatch(
  fnNode: FunctionLikeDeclaration,
  handlerMapParam: ParameterDeclaration,
): DispatchSignature | null {
  const handlerMapSymbol = handlerMapParam.getSymbol();

  // Build the alias set: the param itself, plus any local
  // `const X = <param>` declaration where the initializer's symbol
  // matches the handlerMapSymbol. Rest-spread destructure is
  // handled by walking the destructure pattern.
  const aliasSymbols = new Set<unknown>();
  if (handlerMapSymbol) aliasSymbols.add(handlerMapSymbol);

  // Rest-spread param: `function dispatch({...handlers})` — the
  // ObjectBindingPattern names the local symbol; treat that local
  // as an alias too. `getNameNode()` of the param returns the
  // BindingPattern; iterate its rest element.
  const nameNode = handlerMapParam.getNameNode();
  if (nameNode && Node.isObjectBindingPattern(nameNode)) {
    for (const elem of nameNode.getElements()) {
      if (elem.getDotDotDotToken()) {
        const sym = elem.getNameNode().getSymbol();
        if (sym) aliasSymbols.add(sym);
      }
    }
  }

  const body = fnNode.getBody();
  if (!body) return null;

  // Collect locals aliased from the param: `const h = handlers;`.
  // Plus locals bound to a request-field expression: `const r = req.query.r`.
  const reqKeyLocals = new Map<unknown, DispatchSignature>();
  body.forEachDescendant((d) => {
    if (!Node.isVariableDeclaration(d)) return;
    const init = d.getInitializer();
    if (!init) return;
    const localSym = d.getNameNode().getSymbol();
    if (!localSym) return;

    // Alias of the handler-map.
    if (Node.isIdentifier(init)) {
      const initSym = init.getSymbol();
      if (initSym && aliasSymbols.has(initSym)) aliasSymbols.add(localSym);
    }

    // Local bound to req.<source>.<paramName>.
    const sig = signatureFromExpression(init);
    if (sig) reqKeyLocals.set(localSym, sig);
  });

  // Find element-access on the handler-map (`<X>[<key>]`) where
  // `<key>` is either:
  //   a) a request-field PropertyAccess (`<req>.<source>.<paramName>`) directly, or
  //   b) an Identifier bound to a local that resolves to a request field.
  // We don't require the invocation to be on the same node — once we
  // see the dispatcher index, the existence of the lookup is the
  // signal. (Most real dispatchers also invoke immediately, but a
  // conservative one does `const fn = handlers[key]; fn(req, res)`.)
  let found: DispatchSignature | null = null;
  body.forEachDescendant((d, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    if (!Node.isElementAccessExpression(d)) return;
    const receiver = d.getExpression();
    if (!Node.isIdentifier(receiver)) return;
    const recvSym = receiver.getSymbol();
    if (!recvSym || !aliasSymbols.has(recvSym)) return;

    const indexExpr = d.getArgumentExpression();
    if (!indexExpr) return;

    // Direct: <X>[<req>.<source>.<paramName>].
    const direct = signatureFromExpression(indexExpr);
    if (direct) {
      found = direct;
      return;
    }

    // Indirect: <X>[<localKey>] where localKey was bound to a
    // req-field expression earlier.
    if (Node.isIdentifier(indexExpr)) {
      const sym = indexExpr.getSymbol();
      if (sym) {
        const sig = reqKeyLocals.get(sym);
        if (sig) {
          found = sig;
          return;
        }
      }
    }
  });

  return found;
}

/** Extract a DispatchSignature from `<reqIdent>.<source>.<paramName>`. */
function signatureFromExpression(expr: Node): DispatchSignature | null {
  if (!Node.isPropertyAccessExpression(expr)) return null;
  const paramName = expr.getName();
  const reqSourceProp = expr.getExpression();
  if (!Node.isPropertyAccessExpression(reqSourceProp)) return null;
  const sourceText = reqSourceProp.getName();
  if (!REQ_SOURCES.has(sourceText)) return null;
  return {
    source: sourceText as DispatchSignature['source'],
    paramName,
  };
}

function unwrapToFunctionLike(decl: Node): FunctionLikeDeclaration | null {
  if (Node.isFunctionDeclaration(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init as FunctionLikeDeclaration;
    }
  }
  return null;
}

/**
 * Emit one APIEndpoint per dispatcher key. The route pattern is
 * `<basePath>?<paramName>=<key>` for query/body/headers sources, and
 * `<basePath>/<key>` for `params`-source dispatchers.
 */
export function emitDispatcherEndpoints(
  call: CallExpression,
  basePath: string,
  httpMethod: string,
  match: DispatcherMatch,
  ctx: TsVisitContext,
): APIEndpoint[] {
  const evidence = buildEvidence(call, ctx.sourceFile.filePath);
  const endpoints: APIEndpoint[] = [];

  for (const prop of match.handlerMap.getProperties()) {
    if (!Node.isPropertyAssignment(prop) && !Node.isShorthandPropertyAssignment(prop)) continue;
    const nameNode = prop.getNameNode();
    let key: string | null = null;
    if (Node.isIdentifier(nameNode)) key = nameNode.getText();
    else if (Node.isStringLiteral(nameNode)) key = nameNode.getLiteralValue();
    if (!key) continue;

    const routePattern = match.source === 'params'
      ? `${basePath}/${key}`
      : `${basePath}?${match.paramName}=${key}`;

    // Resolve the handler expression's FunctionDefinition id.
    let handlerFunctionId: string | null = null;
    if (Node.isPropertyAssignment(prop)) {
      const valueExpr = prop.getInitializer();
      if (valueExpr) {
        if (Node.isCallExpression(valueExpr)) {
          // `initializeFoo()` — the callee identifier resolves to the
          // factory; the actual handler is whatever the factory
          // returns. We can't statically resolve that; record null.
          handlerFunctionId = null;
        } else {
          handlerFunctionId = resolveHandlerToFunctionId(valueExpr, call, ctx, 'express');
        }
      }
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      // `{ Foo }` — the value is a same-name binding.
      const ident = prop.getNameNode();
      handlerFunctionId = resolveHandlerToFunctionId(ident, call, ctx, 'express');
    }

    const endpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository: ctx.sourceFile.repository,
        httpMethod: httpMethod.toUpperCase(),
        routePattern,
        filePath: evidence.filePath,
        lineStart: evidence.lineStart + endpoints.length,
      }),
      httpMethod: httpMethod.toUpperCase(),
      routePattern,
      handlerFunctionId,
      framework: 'express',
      repository: ctx.sourceFile.repository,
      evidence: {
        ...evidence,
        confidence: 'heuristic',
      },
    };
    endpoints.push(endpoint);
  }

  return endpoints;
}
