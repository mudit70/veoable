import { Node, SyntaxKind, type Decorator } from 'ts-morph';
import { idFor, type APIEndpoint, type MiddlewareEntry } from '@veoable/schema';
import { recordConfidenceDecision } from '@veoable/observability';
import { type TsFrameworkVisitor, buildEvidence } from '@veoable/lang-ts';

/**
 * NestJS framework visitor (#16, #127).
 *
 * Detects API endpoints declared via NestJS decorators:
 *   @Controller('users')
 *   class UsersController {
 *     @Get(':id') findOne() {}
 *     @Post() create() {}
 *   }
 *
 * The controller prefix + method decorator route = full endpoint path.
 */

const HTTP_METHOD_DECORATORS: ReadonlyMap<string, string> = new Map([
  ['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'],
  ['Delete', 'DELETE'], ['Patch', 'PATCH'],
  ['Head', 'HEAD'], ['Options', 'OPTIONS'], ['All', 'ALL'],
]);

export function createNestjsVisitor(): TsFrameworkVisitor {
  // Track controller prefixes by class declaration.
  const controllerPrefixes = new Map<Node, string>();

  return {
    language: 'ts',
    onNode(ctx, node) {
      // Detect @Controller('prefix') on classes.
      if (Node.isClassDeclaration(node)) {
        const prefix = extractControllerPrefix(node);
        if (prefix !== null) {
          controllerPrefixes.set(node, prefix);
        }
        return;
      }

      // Detect @Get(), @Post(), etc. on methods.
      if (Node.isMethodDeclaration(node)) {
        const httpInfo = extractHttpMethodDecorator(node);
        if (!httpInfo) return;

        // Find the enclosing class to get the controller prefix.
        const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        const controllerPrefix = cls ? (controllerPrefixes.get(cls) ?? '') : '';

        // Compose the full route pattern.
        const methodRoute = httpInfo.route ?? '';
        const routePattern = composePath(controllerPrefix, methodRoute);

        // The handler is the method itself. Compute its FunctionDefinition ID.
        const className = cls?.getName() ?? '<anonymous>';
        const methodName = node.getName();
        const handlerName = `${className}.${methodName}`;
        const handlerFunctionId = idFor.functionDefinition({
          sourceFileId: ctx.sourceFile.id,
          name: handlerName,
          sourceLine: node.getStartLineNumber(),
        });

        // Detect middleware from @UseGuards, @UseInterceptors, @UsePipes (#140).
        const middlewareChain = extractNestMiddleware(node, cls);

        const evidence = buildEvidence(node, ctx.sourceFile.filePath);
        const endpoint: APIEndpoint = {
          nodeType: 'APIEndpoint',
          id: idFor.apiEndpoint({
            repository: ctx.sourceFile.repository,
            httpMethod: httpInfo.method,
            routePattern,
            filePath: evidence.filePath,
            lineStart: evidence.lineStart,
          }),
          httpMethod: httpInfo.method,
          routePattern,
          handlerFunctionId,
          framework: 'nestjs',
          repository: ctx.sourceFile.repository,
          evidence,
          ...(middlewareChain.length > 0 ? { middlewareChain } : {}),
        };
        ctx.emitNode(endpoint);
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Decorator parsing
// ──────────────────────────────────────────────────────────────────────

function extractControllerPrefix(cls: Node): string | null {
  if (!Node.isClassDeclaration(cls)) return null;

  for (const decorator of cls.getDecorators()) {
    const name = decoratorName(decorator);
    if (name === 'Controller') {
      const args = decorator.getArguments();
      if (args.length === 0) return '';
      const firstArg = args[0];
      if (Node.isStringLiteral(firstArg)) {
        return '/' + firstArg.getLiteralValue().replace(/^\/+/, '');
      }
      return '';
    }
  }
  return null;
}

interface HttpMethodInfo {
  method: string;
  route: string | null;
}

function extractHttpMethodDecorator(method: Node): HttpMethodInfo | null {
  if (!Node.isMethodDeclaration(method)) return null;

  for (const decorator of method.getDecorators()) {
    const name = decoratorName(decorator);
    const httpMethod = HTTP_METHOD_DECORATORS.get(name);
    if (!httpMethod) continue;

    const args = decorator.getArguments();
    let route: string | null = null;
    if (args.length > 0 && Node.isStringLiteral(args[0])) {
      route = args[0].getLiteralValue();
    }
    return { method: httpMethod, route };
  }
  return null;
}

function decoratorName(decorator: Decorator): string {
  const expr = decorator.getExpression();
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isIdentifier(callee)) return callee.getText();
  }
  return '';
}

function composePath(prefix: string, route: string | null): string {
  const p = prefix.replace(/\/+$/, '');
  if (!route) return p || '/';
  const r = route.replace(/^\/+/, '');
  return `${p}/${r}`;
}

// ──────────────────────────────────────────────────────────────────────
// Middleware detection (#140)
// ──────────────────────────────────────────────────────────────────────

const MIDDLEWARE_DECORATORS: ReadonlySet<string> = new Set([
  'UseGuards', 'UseInterceptors', 'UsePipes', 'UseFilters',
]);

/**
 * Extract middleware from NestJS decorators on a method and its class.
 * Class-level middleware comes first (lower order), method-level after.
 */
function extractNestMiddleware(method: Node, cls: Node | undefined): MiddlewareEntry[] {
  const chain: MiddlewareEntry[] = [];
  let order = 0;

  // Class-level middleware (applies to all methods).
  if (cls && Node.isClassDeclaration(cls)) {
    for (const decorator of cls.getDecorators()) {
      const entries = parseMiddlewareDecorator(decorator, order);
      chain.push(...entries);
      order += entries.length;
    }
  }

  // Method-level middleware.
  if (Node.isMethodDeclaration(method)) {
    for (const decorator of method.getDecorators()) {
      const entries = parseMiddlewareDecorator(decorator, order);
      chain.push(...entries);
      order += entries.length;
    }
  }

  return chain;
}

function parseMiddlewareDecorator(decorator: Decorator, startOrder: number): MiddlewareEntry[] {
  const name = decoratorName(decorator);
  if (!MIDDLEWARE_DECORATORS.has(name)) return [];

  const args = decorator.getArguments();
  return args.map((arg, i) => ({
    functionId: null,
    name: Node.isIdentifier(arg) ? arg.getText() : arg.getText().slice(0, 50),
    order: startOrder + i,
  }));
}
