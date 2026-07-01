import { Node, SyntaxKind } from 'ts-morph';
import { idFor, type APIEndpoint } from '@veoable/schema';
import { type TsFrameworkVisitor, type TsVisitContext, buildEvidence } from '@veoable/lang-ts';

/**
 * Next.js framework visitor (#37, #60).
 *
 * Detects API endpoints declared via the Next.js App Router convention:
 *
 *   app/api/users/route.ts:
 *     export async function GET(request: NextRequest) { ... }
 *     export async function POST(request: NextRequest) { ... }
 *
 *   app/api/users/[id]/route.ts:
 *     export async function GET(request, { params }) { ... }
 *     export async function DELETE(request, { params }) { ... }
 *
 * Also detects Pages Router API routes:
 *   pages/api/users.ts:
 *     export default function handler(req, res) { ... }
 *
 * Server Actions (#60):
 *   Files with 'use server' directive — every exported function is a
 *   POST endpoint. Individual functions with 'use server' in their body
 *   are also detected.
 *
 *     // app/actions.ts
 *     'use server'
 *     export async function createUser(formData: FormData) { ... }
 *
 * The route pattern is derived from the file path:
 *   app/api/users/route.ts → /api/users
 *   app/api/users/[id]/route.ts → /api/users/:id
 *   pages/api/users.ts → /api/users
 *   pages/api/users/[id].ts → /api/users/:id
 */

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

export function createNextjsVisitor(): TsFrameworkVisitor {
  // Cache per-file 'use server' directive detection
  const fileUseServerCache = new Map<string, boolean>();

  return {
    language: 'ts',

    onNode(ctx, node) {
      const filePath = ctx.sourceFile.filePath;

      // App Router: route.ts files
      if (isAppRouterRoute(filePath)) {
        detectAppRouterEndpoints(ctx, node, filePath, appRouterPathToRoute, 'nextjs');
        return;
      }

      // Pages Router: pages/api/**/*.ts files
      if (isPagesApiRoute(filePath)) {
        detectPagesRouterEndpoints(ctx, node, filePath);
        return;
      }

      // #328 — Medusa.js v2 file-based router: same `export const
      // GET/POST = ...` shape as Next.js App Router, but rooted at
      // `<pkg>/src/api/...` (no `app/` directory). Reuses the App
      // Router detector with a Medusa-specific path translation.
      if (isMedusaApiRoute(filePath)) {
        detectAppRouterEndpoints(ctx, node, filePath, medusaPathToRoute, 'medusa');
        return;
      }

      // Server Actions (#60): files with 'use server' directive
      if (hasFileUseServerDirective(ctx, node, fileUseServerCache)) {
        detectServerActions(ctx, node, filePath);
      }
    },
  };
}

/**
 * App Router: detect exported functions named GET, POST, PUT, DELETE, etc.
 */
function detectAppRouterEndpoints(
  ctx: TsVisitContext,
  node: Node,
  filePath: string,
  pathToRoute: (filePath: string) => string,
  framework: 'nextjs' | 'medusa' = 'nextjs'
): void {
  // Match exported function declarations: export async function GET() {}
  if (Node.isFunctionDeclaration(node)) {
    const name = node.getName();
    if (!name || !HTTP_METHODS.has(name)) return;
    if (!node.isExported()) return;

    const routePattern = pathToRoute(filePath);
    const handlerFnId = idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name,
      sourceLine: node.getStartLineNumber(),
    });

    emitEndpoint(ctx, node, name, routePattern, handlerFnId, framework);
    return;
  }

  // Match exported variable declarations: export const GET = async (req) => {}
  if (Node.isVariableDeclaration(node)) {
    const name = node.getName();
    if (!HTTP_METHODS.has(name)) return;

    // Check if the variable statement is exported
    const varStatement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    if (!varStatement || !Node.isVariableStatement(varStatement) || !varStatement.isExported()) return;

    const init = node.getInitializer();
    if (!init || !(Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return;

    const routePattern = pathToRoute(filePath);
    const handlerFnId = idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name,
      sourceLine: init.getStartLineNumber(),
    });

    emitEndpoint(ctx, init, name, routePattern, handlerFnId, framework);
  }
}

// Pages Router: detect default export in pages/api/ directory.
function detectPagesRouterEndpoints(
  ctx: TsVisitContext,
  node: Node,
  filePath: string
): void {
  // Default export function: export default function handler(req, res) {}
  if (Node.isFunctionDeclaration(node) && node.isDefaultExport()) {
    const routePattern = pagesRouterPathToRoute(filePath);
    // Pages router handles all methods in one function — emit as ALL
    const name = node.getName() ?? 'handler';
    const handlerFnId = idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name,
      sourceLine: node.getStartLineNumber(),
    });
    emitEndpoint(ctx, node, 'ALL', routePattern, handlerFnId);
  }
}

function emitEndpoint(
  ctx: TsVisitContext,
  node: Node,
  httpMethod: string,
  routePattern: string,
  handlerFnId: string,
  framework: 'nextjs' | 'medusa' = 'nextjs'
): void {
  const evidence = buildEvidence(node, ctx.sourceFile.filePath);
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
    handlerFunctionId: handlerFnId,
    framework,
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(endpoint);
}

// ──────────────────────────────────────────────────────────────────────
// Path → route pattern conversion
// ──────────────────────────────────────────────────────────────────────

/** Check if file is an App Router route file. */
function isAppRouterRoute(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return /(?:^|\/)app\/.*\/route\.[tjm]sx?$/.test(normalized)
    || /(?:^|\/)src\/app\/.*\/route\.[tjm]sx?$/.test(normalized);
}

/** Check if file is a Pages Router API route. */
/**
 * #328 — Medusa.js v2 file-based router. Routes live at
 *   `<pkg>/src/api/<segments>/route.ts`
 * with `export const GET/POST/... = async (req, res) => {...}` —
 * the same shape as Next.js App Router but rooted at `src/api/`
 * instead of `app/`. Excludes the `pages/api/` and `app/api/`
 * cases so we don't double-detect.
 *
 * Path anchoring: only match when `api/` (or `src/api/`) is at the
 * top of a recognized prefix — root, `src/`, or
 * `packages/<pkg>/(src/)?`. This avoids false positives like
 * `routes/api/foo/route.ts` (an Express layout) matching when this
 * detector also fires.
 */
function isMedusaApiRoute(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  // Exclude Next.js App Router (`app/.../route.ts`) and Pages Router
  // (`pages/api/...`) layouts up front.
  if (/(?:^|\/)(?:src\/)?app\//.test(normalized)) return false;
  if (/(?:^|\/)(?:src\/)?pages\//.test(normalized)) return false;
  // Recognize Medusa's anchored shapes:
  //   api/.../route.ts                                (analyzed-at-package-root)
  //   src/api/.../route.ts                            (analyzed-at-package-root with src/)
  //   packages/<pkg>/api/.../route.ts                 (analyzed-at-monorepo-root)
  //   packages/<pkg>/src/api/.../route.ts             (Medusa's canonical monorepo layout)
  return /^(?:packages\/[^/]+\/)?(?:src\/)?api\/.*\/route\.[tjm]sx?$/.test(normalized);
}

function isPagesApiRoute(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const inPagesApi =
    /(?:^|\/)pages\/api\//.test(normalized)
    || /(?:^|\/)src\/pages\/api\//.test(normalized);
  if (!inPagesApi) return false;
  // #327 — `_`-prefixed files in `pages/api/` are a community
  // convention (cal.com, blitz, t3-stack) for "private helper,
  // not a route". Next.js docs only formally carve out `_app.tsx`
  // and `_document.tsx` at top-level `pages/`; the API-routes doc
  // says every file under `pages/api/` is mapped, with no
  // exception. We skip them anyway because the empirical false-
  // positive rate is high (cal.com had 1300+ fake endpoints from
  // `_get.ts`/`_post.ts`/`_auth-middleware.ts`/`_utils/...ts`)
  // and a real endpoint at `/api/_foo` is essentially never
  // authored intentionally. `__tests__/` directories are
  // also rejected as a side effect — desired (Jest tests aren't
  // endpoints).
  const afterApi = normalized.split(/(?:^|\/)(?:src\/)?pages\/api\//).pop() ?? '';
  if (afterApi.split('/').some((seg) => seg.startsWith('_'))) return false;
  return true;
}

/**
 * Convert App Router file path to route pattern.
 * app/api/users/route.ts → /api/users
 * app/api/users/[id]/route.ts → /api/users/:id
 * src/app/api/users/route.ts → /api/users
 */
function appRouterPathToRoute(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  // Strip everything up to and including 'app/'
  const match = normalized.match(/(?:^|\/)(?:src\/)?app\/(.*?)\/route\.[tjm]sx?$/);
  if (!match) return '/';
  const segments = match[1];
  return '/' + segments
    .split('/')
    .filter((s) => !s.startsWith('(')) // Remove route groups like (auth)
    .map((s) => s.replace(/^\[\[\.\.\.(.+)\]\]$/, '*$1')) // [[...slug]] → *slug (optional catch-all)
    .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, '*$1'))    // [...slug] → *slug (catch-all)
    .map((s) => s.replace(/^\[(.+)\]$/, ':$1'))           // [id] → :id
    .join('/');
}

/**
 * Convert Pages Router file path to route pattern.
 * pages/api/users.ts → /api/users
 * pages/api/users/[id].ts → /api/users/:id
 * pages/api/users/index.ts → /api/users
 */
/**
 * #328 — Convert Medusa file path to route pattern. Strip everything
 * up to and including `src/api/` (or just `api/`), drop the trailing
 * `/route.ts`, and translate `[param]` segments to `:param`.
 *   src/api/admin/orders/route.ts → /admin/orders
 *   src/api/auth/[actor_type]/[auth_provider]/route.ts → /auth/:actor_type/:auth_provider
 */
function medusaPathToRoute(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(?:src\/)?api\/(.*?)\/route\.[tjm]sx?$/);
  if (!match) return '/';
  const segments = match[1];
  return '/' + segments
    .split('/')
    .map((s) => s.replace(/^\[\[\.\.\.(.+)\]\]$/, '*$1'))
    .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, '*$1'))
    .map((s) => s.replace(/^\[(.+)\]$/, ':$1'))
    .join('/');
}

function pagesRouterPathToRoute(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(?:src\/)?pages\/(.*?)\.[tjm]sx?$/);
  if (!match) return '/';
  let route = match[1];
  // Remove trailing /index
  route = route.replace(/\/index$/, '');
  return '/' + route
    .split('/')
    .map((s) => s.replace(/^\[\[\.\.\.(.+)\]\]$/, '*$1'))  // [[...slug]] optional catch-all
    .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, '*$1'))     // [...slug] catch-all
    .map((s) => s.replace(/^\[(.+)\]$/, ':$1'))            // [id] → :id
    .join('/');
}

// ──────────────────────────────────────────────────────────────────────
// Server Actions (#60)
// ──────────────────────────────────────────────────────────────────────

/**
 * Check if a source file has a top-level 'use server' directive.
 * Caches the result per file path for efficiency.
 */
function hasFileUseServerDirective(
  ctx: TsVisitContext,
  node: Node,
  cache: Map<string, boolean>
): boolean {
  const filePath = ctx.sourceFile.filePath;
  if (cache.has(filePath)) return cache.get(filePath)!;

  // Look for 'use server' string literal as the first expression statement
  // in the source file. ts-morph represents this as an ExpressionStatement
  // wrapping a StringLiteral.
  // Use the node's own source file reference to avoid path resolution issues.
  const sourceFile = node.getSourceFile();

  const firstStatement = sourceFile.getStatements()[0];
  let hasDirective = false;
  if (firstStatement && Node.isExpressionStatement(firstStatement)) {
    const expr = firstStatement.getExpression();
    if (Node.isStringLiteral(expr) && expr.getLiteralValue() === 'use server') {
      hasDirective = true;
    }
  }

  cache.set(filePath, hasDirective);
  return hasDirective;
}

/**
 * Detect Server Actions: exported functions in files with 'use server'
 * directive. Each is emitted as a POST endpoint since Server Actions
 * are called via POST by the Next.js runtime.
 *
 * Route pattern: derived from the file path relative to app/, using
 * `/_action/{functionName}` convention since Server Actions don't have
 * a URL path — they're RPC-style calls.
 */
function detectServerActions(
  ctx: TsVisitContext,
  node: Node,
  filePath: string,
): void {
  // Detect exported function declarations
  if (Node.isFunctionDeclaration(node)) {
    const name = node.getName();
    if (!name) return;
    if (!node.isExported()) return;
    // Skip HTTP method names — those are route handlers, not server actions
    if (HTTP_METHODS.has(name)) return;

    const routePattern = serverActionRoutePattern(filePath, name);
    const handlerFnId = idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name,
      sourceLine: node.getStartLineNumber(),
    });

    emitEndpoint(ctx, node, 'POST', routePattern, handlerFnId);
    return;
  }

  // Detect exported variable declarations bound to arrow/function expressions
  if (Node.isVariableDeclaration(node)) {
    const name = node.getName();
    if (HTTP_METHODS.has(name)) return;

    const varStatement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    if (!varStatement || !varStatement.isExported()) return;

    const init = node.getInitializer();
    if (!init || !(Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return;

    const routePattern = serverActionRoutePattern(filePath, name);
    const handlerFnId = idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name,
      sourceLine: init.getStartLineNumber(),
    });

    emitEndpoint(ctx, init, 'POST', routePattern, handlerFnId);
  }
}

/**
 * Generate a route pattern for a Server Action.
 *
 * Server Actions are RPC-style — they don't have a traditional URL.
 * We use a synthetic pattern: `/_server-action/{filename}/{functionName}`
 * so they can be identified and stitched in the graph.
 */
function serverActionRoutePattern(filePath: string, functionName: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  // Try to extract path relative to app/
  const appMatch = normalized.match(/(?:^|\/)(?:src\/)?app\/(.*?)\.[tjm]sx?$/);
  if (appMatch) {
    return `/_server-action/${appMatch[1]}/${functionName}`;
  }
  // Fallback: use the filename
  const basename = normalized.split('/').pop()?.replace(/\.[tjm]sx?$/, '') ?? 'unknown';
  return `/_server-action/${basename}/${functionName}`;
}
