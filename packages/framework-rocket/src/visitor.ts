import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@adorable/schema';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';

/**
 * Rocket framework visitor (#26, #204 prefix composition).
 *
 * Detects endpoints via attribute macros:
 *   #[get("/items/<id>")] fn get_item(id: u32) -> String {}
 *   #[post("/items")] fn create_item() -> Status {}
 *   #[get("/search?<query>&<limit>")] fn search(...) -> String {}
 *   #[get("/files/<path..>")] fn files(path: PathBuf) -> ... {}
 *
 * Composes mount("/...", routes![...]) prefixes (#204):
 *   #[get("/<id>")]
 *   fn get_user(id: u32) -> String { ... }
 *
 *   rocket::build()
 *     .mount("/api/users", routes![get_user, list_users])
 *
 *   →  GET /api/users/:id (was /:id)
 *
 * The pre-pass scans for `<chain>.mount("/p", routes![<id1>, <id2>])`
 * calls. Each identifier listed in the `routes!` macro is mapped to
 * the mount prefix. When a function's HTTP attribute fires, the
 * prefix is prepended to the route literal.
 *
 * Conservative on purpose:
 *   - Same-file only.
 *   - mount path must be a string literal.
 *   - `routes!` arguments must be bare identifiers — module-qualified
 *     names like `users::list_users` are out of scope (no good
 *     same-file mapping).
 *   - A function appearing in multiple `mount(...)` calls — last one
 *     wins (the same function mounted twice is unusual but legal).
 *
 * Rocket uses `<param>` for path params → normalized to `:param`.
 * `<path..>` (catch-all) → normalized to `*path`.
 * Query params after `?` are stripped from the route pattern.
 *
 * Only matches files importing from `rocket` or using
 * `extern crate rocket`.
 *
 * Disambiguation with Actix: per-file import checks (`rocket` vs `actix_web`).
 *
 * TODO: Handler resolution — handlerFunctionId is always null.
 */

const ROCKET_HTTP_ATTRS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'head', 'options',
]);

export function createRocketVisitor(): RustFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();
  // Per-file map of function name → list of mount prefixes. A function
  // can legally appear in multiple `mount(...)` calls (Rocket registers
  // a distinct route per mount); the visitor emits one endpoint per
  // prefix below. Empty / missing → emit one unprefixed endpoint.
  const prefixesByFile = new Map<string, Map<string, string[]>>();

  return {
    language: 'rust',
    onNode(ctx, node) {
      const fileId = ctx.sourceFile.id;

      if (node.type !== 'function_item') return;

      if (!fileImportsRocket(node, ctx.sourceFile.filePath, fileImportCache)) return;

      // Lazy pre-pass on first function in this file.
      if (!prefixesByFile.has(fileId)) {
        prefixesByFile.set(fileId, scanFileForMountPrefixes(node.tree.rootNode));
      }

      const result = findHttpAttributeInPrecedingSiblings(node);
      if (!result) return;

      const { method, routePattern, attrNode } = result;

      // Compose prefixes from the function's name. Rocket can mount
      // the same fn at multiple paths — emit one endpoint per mount.
      // Empty / missing → emit a single unprefixed endpoint.
      const nameNode = node.childForFieldName('name');
      const fnName = nameNode?.text ?? null;
      const prefixes = fnName
        ? (prefixesByFile.get(fileId)?.get(fnName) ?? [''])
        : [''];

      for (const prefix of prefixes) {
        const composedPath = joinPaths(prefix, routePattern);
        const endpoint: APIEndpoint = {
          nodeType: 'APIEndpoint',
          id: idFor.apiEndpoint({
            repository: ctx.sourceFile.repository,
            httpMethod: method,
            routePattern: composedPath,
            filePath: ctx.sourceFile.filePath,
            lineStart: attrNode.startPosition.row + 1,
          }),
          httpMethod: method,
          routePattern: composedPath,
          handlerFunctionId: null,
          framework: 'rocket',
          repository: ctx.sourceFile.repository,
          evidence: {
            filePath: ctx.sourceFile.filePath,
            lineStart: attrNode.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            snippet: (attrNode.text + '\n' + node.text).slice(0, 300),
            confidence: 'exact',
          },
        };
        ctx.emitNode(endpoint);
      }
    },
  };
}

function findHttpAttributeInPrecedingSiblings(
  fnNode: SyntaxNode
): { method: string; routePattern: string; attrNode: SyntaxNode } | null {
  let current = fnNode.previousNamedSibling;
  while (current && current.type === 'attribute_item') {
    const result = parseRocketAttribute(current);
    if (result) {
      return { ...result, attrNode: current };
    }
    current = current.previousNamedSibling;
  }
  return null;
}

function parseRocketAttribute(attr: SyntaxNode): { method: string; routePattern: string } | null {
  const attrNode = attr.children.find((c) => c.type === 'attribute');
  if (!attrNode) return null;

  const nameNode = attrNode.children.find((c) => c.type === 'identifier');
  if (!nameNode) return null;
  if (!ROCKET_HTTP_ATTRS.has(nameNode.text)) return null;

  const tokenTree = attrNode.children.find((c) => c.type === 'token_tree');
  if (!tokenTree) return null;

  const strLit = tokenTree.children.find((c) => c.type === 'string_literal');
  if (!strLit) return null;

  const rawPath = strLit.text.slice(1, -1);
  // Strip query params: "/search?<query>&<limit>" → "/search"
  const pathOnly = rawPath.split('?')[0];
  // Rocket <param> → :param, <path..> → *path
  const routePattern = pathOnly
    .replace(/<(\w+)\.\.>/g, '*$1')
    .replace(/<(\w+)>/g, ':$1');

  return { method: nameNode.text.toUpperCase(), routePattern };
}

function fileImportsRocket(node: SyntaxNode, filePath: string, cache: Map<string, boolean>): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const root = node.tree.rootNode;
  let has = false;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    // m3 fix: removed dead macro_invocation check; only use_declaration
    // and extern_crate_declaration are relevant
    if (child.type === 'use_declaration' && child.text.includes('rocket')) {
      has = true;
      break;
    }
    if (child.type === 'extern_crate_declaration' && child.text.includes('rocket')) {
      has = true;
      break;
    }
  }
  cache.set(filePath, has);
  return has;
}

// ──────────────────────────────────────────────────────────────────────
// Mount prefix scanning (#204)
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the file for `<chain>.mount("/p", routes![<id1>, <id2>, ...])`
 * calls. Map each identifier in the routes! macro to the mount path.
 *
 * Multiple mounts of the same function (rare) → last write wins.
 */
function scanFileForMountPrefixes(rootNode: SyntaxNode): Map<string, string[]> {
  const out = new Map<string, string[]>();

  function walk(node: SyntaxNode): void {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn && fn.type === 'field_expression') {
        const field = fn.childForFieldName('field');
        if (field?.text === 'mount') {
          processMountCall(node, out);
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(rootNode);
  return out;
}

function processMountCall(call: SyntaxNode, out: Map<string, string[]>): void {
  const args = call.childForFieldName('arguments');
  if (!args) return;

  // First arg: mount path string.
  const mountPath = findFirstStringArg(args);
  if (mountPath === null) return;

  // Second arg: routes! macro_invocation.
  let macro: SyntaxNode | null = null;
  let count = 0;
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (!child.isNamed) continue;
    if (child.type === 'line_comment' || child.type === 'block_comment') continue;
    count++;
    if (count === 2) {
      macro = child;
      break;
    }
  }
  if (!macro || macro.type !== 'macro_invocation') return;

  // Macro name: must be `routes`.
  const macroName = macro.children.find((c) => c.type === 'identifier');
  if (!macroName || macroName.text !== 'routes') return;

  // Token tree contents are raw tokens. For a scoped path like
  // `users::list_users`, tree-sitter emits identifier "users", "::",
  // identifier "list_users". We want only the FINAL segment of each
  // path — the function name — not module-path prefixes. Skip an
  // identifier whose immediate next sibling token is `::`.
  // (tree-sitter-rust does not emit whitespace nodes inside
  // token_tree, so a positional check on child(i+1) is sufficient.)
  const tokenTree = macro.children.find((c) => c.type === 'token_tree');
  if (!tokenTree) return;
  for (let i = 0; i < tokenTree.childCount; i++) {
    const tok = tokenTree.child(i)!;
    if (tok.type !== 'identifier') continue;
    // Look at the next sibling (in raw children, including non-named).
    const next = i + 1 < tokenTree.childCount ? tokenTree.child(i + 1) : null;
    if (next && next.type === '::') continue; // not the last segment
    const list = out.get(tok.text);
    if (list) list.push(mountPath);
    else out.set(tok.text, [mountPath]);
  }
}

function findFirstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (
      child.type === 'string_literal' ||
      child.type === 'interpreted_string_literal' ||
      child.type === 'raw_string_literal'
    ) {
      return stripStringQuotes(child.text);
    }
  }
  return null;
}

function stripStringQuotes(text: string): string {
  if (text.startsWith('r#"') && text.endsWith('"#')) return text.slice(3, -2);
  if (text.startsWith('r"') && text.endsWith('"')) return text.slice(2, -1);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function joinPaths(prefix: string, suffix: string): string {
  if (prefix === '') return suffix;
  if (suffix === '') return prefix;
  const p = prefix.replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : '/' + suffix;
  return p + s;
}
