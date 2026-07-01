import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@adorable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';

/**
 * chi router visitor.
 *
 *   r := chi.NewRouter()
 *   r.Get("/users", listUsers)
 *   r.Post("/users", createUser)
 *   r.Put("/users/{id}", updateUser)
 *   r.Delete("/users/{id}", deleteUser)
 *   r.Patch("/users/{id}", patchUser)
 *   r.Head("/users", headUsers)
 *   r.Options("/users", optionsUsers)
 *   r.Method("CUSTOM", "/path", handler)
 *   r.MethodFunc("PROPFIND", "/path", handlerFn)
 *
 * Receiver heuristic: file must `import "github.com/go-chi/chi"` AND
 * the receiver name must look like a router (`r`, `router`, `mux`,
 * `api`, or a `<word>Router` / `<word>Mux` suffix).
 *
 * Conservative v1 limits:
 *   - No prefix composition for `r.Route("/api", func(r chi.Router)
 *     { ... })`. Inner routes emit with the literal path. Real
 *     codebases that use Route() heavily will see unprefixed
 *     patterns until v2 — tracked as a separate follow-up.
 *   - `r.Mount("/admin", subRouter)` is not detected as an endpoint.
 *     The subRouter's routes emit at their own definition site.
 */

const HTTP_VERB_METHODS: ReadonlyMap<string, string> = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Delete', 'DELETE'],
  ['Patch', 'PATCH'],
  ['Head', 'HEAD'],
  ['Options', 'OPTIONS'],
  ['Connect', 'CONNECT'],
  ['Trace', 'TRACE'],
]);

const ROUTER_RECEIVER_RE = /^(?:[a-zA-Z_][\w]*\.)?(?:r|router|mux|api|.*Router|.*Mux)$/;

export function createChiVisitor(): GoFrameworkVisitor {
  const importsChiCache = new Map<string, boolean>();
  const fileImportsChi = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsChiCache.get(filePath);
    if (cached !== undefined) return cached;
    const value = scanFileImportsChi(root);
    importsChiCache.set(filePath, value);
    return value;
  };

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImportsChi(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fnNode = node.childForFieldName('function');
      if (!fnNode || fnNode.type !== 'selector_expression') return;

      const field = fnNode.childForFieldName('field');
      const operand = fnNode.childForFieldName('operand');
      if (!field || !operand) return;

      const methodName = field.text;
      const receiverText = operand.text;
      if (!ROUTER_RECEIVER_RE.test(receiverText)) return;

      const args = node.childForFieldName('arguments');
      if (!args) return;

      // ── `r.<verb>("/path", handler)` ──────────────────────────
      const httpMethod = HTTP_VERB_METHODS.get(methodName);
      if (httpMethod) {
        const path = readStringLiteralArg(args, 0);
        if (path === null) return;
        emitEndpoint(ctx, node, httpMethod, normalizePath(path));
        return;
      }

      // ── `r.Method("CUSTOM", "/path", handler)` ─────────────────
      // ── `r.MethodFunc("PROPFIND", "/path", handlerFn)` ─────────
      // Chi explicitly allows arbitrary verb strings (PROPFIND,
      // MKCOL, BIND, etc.) — no validation against an enumerated
      // set; uppercase the literal and emit.
      if (methodName === 'Method' || methodName === 'MethodFunc') {
        const verb = readStringLiteralArg(args, 0);
        const pathArg = readStringLiteralArg(args, 1);
        if (verb === null || pathArg === null) return;
        emitEndpoint(ctx, node, verb.toUpperCase(), normalizePath(pathArg));
        return;
      }

      // ── `r.HandleFunc("/path", handler)` — fallthrough verb     ──
      if (methodName === 'HandleFunc' || methodName === 'Handle') {
        const path = readStringLiteralArg(args, 0);
        if (path === null) return;
        // No verb known — emit as 'ALL' (any verb), same convention
        // framework-gohttp uses for stdlib registrations.
        emitEndpoint(ctx, node, 'ALL', normalizePath(path));
        return;
      }
    },
  };
}

function emitEndpoint(
  ctx: GoVisitContext,
  node: SyntaxNode,
  httpMethod: string,
  routePattern: string,
): void {
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod,
      routePattern,
      filePath: ctx.sourceFile.filePath,
      lineStart: node.startPosition.row + 1,
    }),
    httpMethod,
    routePattern,
    handlerFunctionId: null,
    framework: 'chi',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      snippet: node.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(endpoint);
}

function normalizePath(p: string): string {
  // Chi uses {name} path params — same convention as net/http 1.22.
  // Normalize to :name (Express-style) for cross-framework matching.
  return p.replace(/\{(\w+)(?::[^}]+)?\}/g, ':$1');
}

function nthArg(args: SyntaxNode, index: number): SyntaxNode | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === index) return c;
    seen++;
  }
  return null;
}

function readStringLiteralArg(args: SyntaxNode, index: number): string | null {
  const arg = nthArg(args, index);
  if (!arg) return null;
  if (arg.type === 'interpreted_string_literal' || arg.type === 'raw_string_literal') {
    return arg.text.slice(1, -1);
  }
  return null;
}

function scanFileImportsChi(root: SyntaxNode): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (!c) continue;
    if (c.type !== 'import_declaration') continue;
    if (c.text.includes('go-chi/chi')) return true;
  }
  return false;
}
