import * as path from 'node:path';
import { Node, type CallExpression, type Expression } from 'ts-morph';
import {
  idFor,
  type APIEndpoint,
  type MiddlewareEntry,
  type ResponseShape,
} from '@adorable/schema';
import { recordConfidenceDecision } from '@adorable/observability';
import { type TsFrameworkVisitor, buildEvidence, resolveToString } from '@adorable/lang-ts';

/**
 * Fastify framework visitor (#17, #110).
 *
 * Detects server-side API endpoints declared via the Fastify routing
 * API and emits canonical `APIEndpoint` nodes.
 *
 * Detection shapes:
 *
 *   fastify.get('/path', handler)
 *   fastify.get('/path', { handler })
 *   fastify.get('/path', opts, handler)
 *   fastify.post('/path', async (req, reply) => { ... })
 *   app.get('/path', handler)
 *   server.get('/path', handler)
 *
 * The receiver identifier must match `/^(this\.)?(fastify|app|server|instance)$/`.
 *
 * Handler resolution:
 *   - Inline arrow/function expression → handlerFunctionId: null
 *   - Identifier → resolve via ts-morph to same-file FunctionDefinition
 *   - Options object with `handler` key → resolve the value
 *   - Cross-file identifiers → follow imports via rootDir
 */

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all',
]);

const RECEIVER_NAME_PATTERN = /^(this\.)?(fastify|app|server|instance)$/;

export interface FastifyPrefixMapping {
  prefix: string;
  targetSourceFileId: string;
  repository: string;
}

export interface FastifyVisitorWithMappings extends TsFrameworkVisitor {
  getPrefixMappings(): FastifyPrefixMapping[];
}

export function createFastifyVisitor(): FastifyVisitorWithMappings {
  const prefixMappings: FastifyPrefixMapping[] = [];

  return {
    language: 'ts',
    getPrefixMappings: () => [...prefixMappings],
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      // Detect fastify.register(plugin, { prefix: '/path' }) for
      // prefix composition.
      const registerInfo = classifyRegisterCall(node, ctx);
      if (registerInfo) {
        prefixMappings.push(registerInfo);
        return;
      }

      const classification = classifyRouteCall(node);
      if (!classification) return;

      const { httpMethod, routePattern, handlerExpr, receiverText } = classification;

          if (receiverText !== 'fastify' && receiverText !== 'app') {
        recordConfidenceDecision('fastify receiver matched by name heuristic', {
          'fastify.receiver': receiverText,
          'fastify.method': httpMethod,
          'call.sourceLine': node.getStartLineNumber(),
        });
      }

      const handlerFunctionId = resolveHandlerFunctionId(handlerExpr, node, ctx);

      // #110 — @fastify/websocket: `fastify.get('/ws', { websocket: true }, handler)`.
      // When the options object has `websocket: true`, override
      // httpMethod to `WS` so the flow stitcher and downstream
      // analysis treat the endpoint as a websocket route, not a GET.
      const isWebsocket = hasWebsocketFlag(node.getArguments());
      const finalHttpMethod = (isWebsocket ? 'WS' : httpMethod).toUpperCase();

      // #110 — pre-handler hook chain (preHandler / onRequest /
      // preValidation). Captures @fastify/jwt's `fastify.authenticate`
      // pattern as a MiddlewareEntry so consumers can reason about
      // route-level auth without inspecting handler bodies.
      const middlewareChain = extractMiddlewareChain(node.getArguments());

      // #110 — declarative response schemas:
      //   fastify.get('/users', { schema: { response: { 200: {...} } } }, handler)
      // Fastify route options can carry per-status-code schemas under
      // `schema.response`. Extracting them complements the AST-observed
      // `res.json()` / `reply.send()` responses captured on the handler
      // FunctionDefinition: schema responses are what the route says
      // it returns, observed responses are what the code actually
      // sends. Both are useful downstream.
      const declarativeResponses = extractDeclarativeResponses(node.getArguments());

      const evidence = buildEvidence(node, ctx.sourceFile.filePath);
      const endpoint: APIEndpoint = {
        nodeType: 'APIEndpoint',
        id: idFor.apiEndpoint({
          repository: ctx.sourceFile.repository,
          httpMethod: finalHttpMethod,
          routePattern,
          filePath: evidence.filePath,
          lineStart: evidence.lineStart,
        }),
        httpMethod: finalHttpMethod,
        routePattern,
        handlerFunctionId,
        framework: isWebsocket ? 'fastify-websocket' : 'fastify',
        repository: ctx.sourceFile.repository,
        ...(middlewareChain.length > 0 ? { middlewareChain } : {}),
        ...(declarativeResponses.length > 0 ? { responses: declarativeResponses } : {}),
        evidence,
      };
      ctx.emitNode(endpoint);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Call classification
// ──────────────────────────────────────────────────────────────────────

/**
 * Detect `fastify.register(plugin, { prefix: '/path' })` calls.
 * Returns the prefix and the resolved target source file ID.
 */
function classifyRegisterCall(
  call: CallExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0]
): FastifyPrefixMapping | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  if (callee.getNameNode().getText() !== 'register') return null;

  const receiver = callee.getExpression();
  if (!RECEIVER_NAME_PATTERN.test(receiver.getText())) return null;

  const args = call.getArguments();
  if (args.length < 2) return null;

  // First arg: the plugin function (identifier).
  const pluginArg = args[0] as Expression;
  if (!Node.isIdentifier(pluginArg)) return null;

  // Second arg: options object with `prefix`.
  const optsArg = args[1] as Expression;
  if (!Node.isObjectLiteralExpression(optsArg)) return null;

  let prefix: string | null = null;
  for (const prop of optsArg.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = prop.getNameNode();
      if (Node.isIdentifier(name) && name.getText() === 'prefix') {
        const init = prop.getInitializer();
        if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
          prefix = init.getLiteralValue();
        }
      }
    }
  }
  if (!prefix) return null;

  // Resolve the plugin function to its source file.
  const symbol = pluginArg.getSymbol();
  if (!symbol) return null;
  const decls = symbol.getDeclarations();
  if (decls.length === 0) return null;

  const decl = decls[0];
  // Follow imports to the target file.
  let targetFile;
  if (Node.isImportSpecifier(decl) || Node.isImportClause(decl) || Node.isNamespaceImport(decl)) {
    let current = decl as Node;
    while (current && !Node.isImportDeclaration(current)) {
      current = current.getParent() as Node;
    }
    if (!current || !Node.isImportDeclaration(current)) return null;
    targetFile = current.getModuleSpecifierSourceFile();
  } else {
    // Same-file plugin function.
    targetFile = decl.getSourceFile();
  }
  if (!targetFile) return null;

  const targetFilePath = relativePath(ctx.rootDir, targetFile.getFilePath());
  const targetSourceFileId = idFor.sourceFile({
    repository: ctx.repository,
    filePath: targetFilePath,
  });

  return { prefix, targetSourceFileId, repository: ctx.repository };
}

interface RouteClassification {
  httpMethod: string;
  routePattern: string;
  handlerExpr: Expression | null;
  receiverText: string;
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

  // First arg must be a string path. Computed paths fall back to the
  // widened lang-ts resolver (#193) so imported constants and pure-
  // function helpers resolve.
  const pathArg = args[0];
  let routePattern: string;
  if (Node.isStringLiteral(pathArg) || Node.isNoSubstitutionTemplateLiteral(pathArg)) {
    routePattern = pathArg.getLiteralValue();
  } else {
    const resolved = resolveToString(pathArg);
    if (resolved === null) {
      recordConfidenceDecision('fastify route path is not a string literal', {
        'fastify.method': method,
        'call.sourceLine': call.getStartLineNumber(),
      });
      return null;
    }
    routePattern = resolved;
  }

  // Determine handler — several Fastify patterns:
  //   fastify.get('/path', handler)
  //   fastify.get('/path', { handler })
  //   fastify.get('/path', opts, handler)
  //   fastify.get('/path', async (req, reply) => { ... })
  const handlerExpr = resolveHandlerArg(args);

  return { httpMethod: method, routePattern, handlerExpr, receiverText };
}

/**
 * Find the handler expression from Fastify route arguments.
 * Supports:
 *   [path, handler]
 *   [path, { handler: fn }]
 *   [path, opts, handler]
 */
function resolveHandlerArg(args: Node[]): Expression | null {
  if (args.length === 2) {
    const second = args[1] as Expression;
    // { handler: fn } options object
    if (Node.isObjectLiteralExpression(second)) {
      return extractHandlerFromOptions(second);
    }
    // Direct handler (arrow, function, identifier)
    return second;
  }
  if (args.length >= 3) {
    // fastify.get('/path', opts, handler) — last arg is the handler
    const last = args[args.length - 1] as Expression;
    // But if the second arg is an options object with a handler key, use that
    const second = args[1] as Expression;
    if (Node.isObjectLiteralExpression(second)) {
      const fromOpts = extractHandlerFromOptions(second);
      if (fromOpts) return fromOpts;
    }
    return last;
  }
  return null;
}

function extractHandlerFromOptions(opts: Node): Expression | null {
  if (!Node.isObjectLiteralExpression(opts)) return null;
  for (const prop of opts.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = prop.getNameNode();
      if (Node.isIdentifier(name) && name.getText() === 'handler') {
        return prop.getInitializer() as Expression ?? null;
      }
    }
    if (Node.isShorthandPropertyAssignment(prop)) {
      if (prop.getName() === 'handler') {
        // Shorthand { handler } — the identifier IS the handler
        // Return null since we can't easily get the Expression; the
        // caller will treat this as unresolved.
        return null;
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Handler resolution
// ──────────────────────────────────────────────────────────────────────

function resolveHandlerFunctionId(
  handlerExpr: Expression | null,
  call: CallExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0]
): string | null {
  if (!handlerExpr) return null;
  if (Node.isArrowFunction(handlerExpr) || Node.isFunctionExpression(handlerExpr)) {
    // Inline handler: compute the FunctionDefinition ID that the
    // structural extractor emits for this callback. The name matches
    // the pattern in inferCallbackName: "METHOD /route$handler".
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
      const method = callee.getNameNode().getText().toUpperCase();
      const args = call.getArguments();
      if (args.length >= 2) {
        const pathArg = args[0];
        if (Node.isStringLiteral(pathArg) || Node.isNoSubstitutionTemplateLiteral(pathArg)) {
          const route = pathArg.getLiteralValue();
          const name = `${method} ${route}$handler`;
          return idFor.functionDefinition({
            sourceFileId: ctx.sourceFile.id,
            name,
            sourceLine: handlerExpr.getStartLineNumber(),
          });
        }
      }
    }
    return null;
  }
  if (!Node.isIdentifier(handlerExpr)) return null;

  const symbol = handlerExpr.getSymbol();
  if (!symbol) {
    recordConfidenceDecision('fastify handler identifier did not resolve', {
      'fastify.handler': handlerExpr.getText(),
      'call.sourceLine': call.getStartLineNumber(),
    });
    return null;
  }

  const decls = symbol.getDeclarations();
  if (decls.length === 0) return null;

  const decl = decls[0];

  // Cross-file: follow imports
  if (
    Node.isImportSpecifier(decl) ||
    Node.isImportClause(decl) ||
    Node.isNamespaceImport(decl)
  ) {
    return resolveCrossFileHandler(decl, handlerExpr, ctx);
  }

  // Same-file
  const fnNode = unwrapToFunctionShape(decl);
  if (!fnNode) return null;
  if (fnNode.getSourceFile() !== call.getSourceFile()) return null;

  const name = nameForDeclaration(decl, fnNode);
  if (!name) return null;

  return idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name,
    sourceLine: fnNode.getStartLineNumber(),
  });
}

function resolveCrossFileHandler(
  importDecl: Node,
  handlerExpr: Expression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0]
): string | null {
  let targetFile;
  try {
    let current = importDecl as Node;
    while (current && !Node.isImportDeclaration(current)) {
      current = current.getParent() as Node;
    }
    if (!current || !Node.isImportDeclaration(current)) return null;
    targetFile = current.getModuleSpecifierSourceFile();
  } catch {
    return null;
  }

  if (!targetFile) return null;

  const targetFilePath = relativePath(ctx.rootDir, targetFile.getFilePath());
  const targetSourceFileId = idFor.sourceFile({
    repository: ctx.repository,
    filePath: targetFilePath,
  });

  const handlerName = handlerExpr.getText();
  const targetSymbol = targetFile.getExportedDeclarations().get(handlerName);
  if (!targetSymbol || targetSymbol.length === 0) return null;

  const targetDecl = targetSymbol[0];
  const fnNode = unwrapToFunctionShape(targetDecl);
  if (!fnNode) return null;

  const name = nameForDeclaration(targetDecl, fnNode);
  if (!name) return null;

  return idFor.functionDefinition({
    sourceFileId: targetSourceFileId,
    name,
    sourceLine: fnNode.getStartLineNumber(),
  });
}

function unwrapToFunctionShape(decl: Node): Node | null {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isMethodDeclaration(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isFunctionExpression(decl)
  ) {
    return decl;
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init;
    }
  }
  return null;
}

function nameForDeclaration(decl: Node, fnNode: Node): string | null {
  if (Node.isFunctionDeclaration(fnNode)) return fnNode.getName() ?? null;
  if (Node.isVariableDeclaration(decl)) return decl.getName();
  return null;
}

function relativePath(rootDir: string, absolutePath: string): string {
  const rel = path.relative(rootDir, absolutePath);
  return rel.split(path.sep).join('/');
}

/**
 * #110 — extract pre-handler hooks from Fastify route options.
 *
 * Recognized hook keys: preHandler, onRequest, preValidation,
 * preParsing, preSerialization, onSend, onResponse. Per-key value
 * can be a single expression or an array of expressions.
 *
 * Returns a flat list of MiddlewareEntry, ordered by hook-key
 * occurrence then array position. The functionId is left null at
 * this layer — a downstream resolver pass can populate it for
 * cases where the middleware is a same-file Identifier.
 */
const FASTIFY_HOOK_KEYS: ReadonlyArray<string> = [
  'onRequest', 'preParsing', 'preValidation', 'preHandler',
  'preSerialization', 'onSend', 'onResponse',
];

function extractMiddlewareChain(args: ReadonlyArray<Node>): MiddlewareEntry[] {
  for (const arg of args) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const out: MiddlewareEntry[] = [];
    let order = 0;
    for (const key of FASTIFY_HOOK_KEYS) {
      const prop = arg.getProperty(key);
      if (!prop || !Node.isPropertyAssignment(prop)) continue;
      const init = prop.getInitializer();
      if (!init) continue;

      const exprs: Node[] = Node.isArrayLiteralExpression(init)
        ? [...init.getElements()]
        : [init];

      for (const expr of exprs) {
        const name = nameForMiddlewareExpr(expr);
        if (!name) continue;
        out.push({ functionId: null, name, order: order++ });
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

function nameForMiddlewareExpr(expr: Node): string | null {
  // Peel `as` casts (`fastify.authenticate as Handler`) — type-narrowing
  // wrappers shouldn't change the middleware identity.
  if (Node.isAsExpression(expr)) return nameForMiddlewareExpr(expr.getExpression());
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getText();
  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isIdentifier(callee)) return callee.getText() + '()';
    if (Node.isPropertyAccessExpression(callee)) return callee.getText() + '()';
  }
  return null;
}

/**
 * #110 — extract declarative response schemas from Fastify route
 * options.
 *
 *   fastify.get('/users', {
 *     schema: {
 *       response: {
 *         200: { type: 'array', items: { $ref: 'User' } },
 *         404: { type: 'object', properties: { error: { type: 'string' } } },
 *         '4xx': { ... },   // catch-all also supported
 *         default: { ... },
 *       },
 *     },
 *   }, handler);
 *
 * For each entry in `schema.response`, we emit one `ResponseShape`
 * with:
 *   - `statusCode`: parsed from the key when it's a numeric literal,
 *     or null when it's a wildcard (`'4xx'`, `'5xx'`, `'default'`).
 *   - `bodyExpression`: the schema value's source text (the schema
 *     itself, JSON-Schema-shaped). Truncated to keep payloads sane;
 *     consumers wanting the full text can rehydrate from the
 *     source file at `sourceLine`.
 *   - `isErrorPath`: true when the parsed status is >= 400 or the
 *     key is a 4xx/5xx wildcard.
 *   - `sourceLine`: where the per-status property starts.
 *
 * Scans all args because Fastify accepts the schema in either the
 * second arg `{schema, handler}` or the second of `(path, opts, handler)`.
 */
const MAX_BODY_EXPRESSION_LENGTH = 240;

function extractDeclarativeResponses(args: ReadonlyArray<Node>): ResponseShape[] {
  for (const arg of args) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const schemaProp = arg.getProperty('schema');
    if (!schemaProp || !Node.isPropertyAssignment(schemaProp)) continue;
    const schemaInit = schemaProp.getInitializer();
    if (!schemaInit || !Node.isObjectLiteralExpression(schemaInit)) continue;
    const responseProp = schemaInit.getProperty('response');
    if (!responseProp || !Node.isPropertyAssignment(responseProp)) continue;
    const responseInit = responseProp.getInitializer();
    if (!responseInit || !Node.isObjectLiteralExpression(responseInit)) continue;

    const out: ResponseShape[] = [];
    for (const prop of responseInit.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const nameNode = prop.getNameNode();
      // Keys can be numeric literals (200), string literals ('200',
      // '4xx', 'default'), or computed.
      let rawKey: string | null = null;
      if (Node.isNumericLiteral(nameNode)) rawKey = nameNode.getText();
      else if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
        rawKey = nameNode.getLiteralValue();
      } else if (Node.isIdentifier(nameNode)) {
        rawKey = nameNode.getText();
      }
      if (rawKey === null) continue;

      const init = prop.getInitializer();
      if (!init) continue;

      const { statusCode, isErrorPath } = classifyStatusKey(rawKey);
      const rawBody = init.getText();
      const bodyExpression =
        rawBody.length > MAX_BODY_EXPRESSION_LENGTH
          ? rawBody.slice(0, MAX_BODY_EXPRESSION_LENGTH) + '…'
          : rawBody;

      out.push({
        statusCode,
        bodyExpression,
        isErrorPath,
        sourceLine: prop.getStartLineNumber(),
      });
    }
    if (out.length > 0) return out;
  }
  return [];
}

/**
 * Map a Fastify response-key (`200`, `'4xx'`, `'default'`, etc.) to a
 * statusCode + isErrorPath pair. Numeric keys parse directly;
 * wildcards (`Nxx`) and `default` keep statusCode null but still
 * carry the error-vs-success signal when the bucket is known.
 */
function classifyStatusKey(key: string): { statusCode: number | null; isErrorPath: boolean } {
  const trimmed = key.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && Number.isInteger(asNumber) && asNumber >= 100 && asNumber < 600) {
    return { statusCode: asNumber, isErrorPath: asNumber >= 400 };
  }
  // `2xx` / `4xx` / `5xx` wildcards.
  const wildcardMatch = trimmed.match(/^([1-5])xx$/i);
  if (wildcardMatch) {
    const bucket = Number(wildcardMatch[1]);
    return { statusCode: null, isErrorPath: bucket >= 4 };
  }
  // `default` — no status, conservatively treat as non-error.
  return { statusCode: null, isErrorPath: false };
}

/**
 * #110 — detect `websocket: true` in any of the route call arguments.
 *
 * Fastify accepts route options at any of:
 *   - second arg `{ websocket: true, ...opts }`
 *   - second arg `{ ..., handler }` where the third arg slot is empty
 * We scan all args for an ObjectLiteral with a `websocket` property
 * whose value is the literal `true`.
 */
function hasWebsocketFlag(args: ReadonlyArray<Node>): boolean {
  for (const arg of args) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const prop = arg.getProperty('websocket');
    if (!prop || !Node.isPropertyAssignment(prop)) continue;
    const init = prop.getInitializer();
    if (!init) continue;
    if (init.getKindName() === 'TrueKeyword') return true;
  }
  return false;
}
