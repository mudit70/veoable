import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Cross-file handler resolver for Axum route registrations.
 *
 * Same shape as `framework-gin`'s handler-resolver. Axum routes look
 * like:
 *
 *   Router::new()
 *       .route("/api/orders", get(list_orders).post(place_order))
 *       .route("/api/orders/:id", delete(cancel_order))
 *       .route("/api/portfolio", get(get_portfolio));
 *
 *   pub async fn list_orders(...) { … }
 *   pub async fn place_order(...) { … }
 *   pub async fn cancel_order(...) { … }
 *   pub async fn get_portfolio(...) { … }
 *
 * The visitor sees the `get(list_orders)` call site but not the
 * definition. A per-file scan won't cross the package boundary
 * (`orders::list`-style cross-module handlers are common in real
 * axum apps). This resolver walks every `.rs` file under rootDir
 * once at project-load time and records every function declaration.
 * The visitor then looks up handler call sites by name.
 *
 * Bare identifiers (`get(handleX)`) and scoped paths (`get(orders::list)`)
 * are both handled — the last `::` segment becomes the lookup name.
 * Method-receiver handlers (`get(state.list)`) get the method name
 * looked up. The receiver's binding type is ignored — name uniqueness
 * substitutes for type inference, same as the gin resolver.
 *
 * What we resolve (uniqueness gating):
 *   - if a function name is globally unique → emit its id
 *   - if it's not unique → leave null (avoid false positives)
 *
 * Closures (`get(|| async { "ok" })`) yield no lookup name and
 * therefore no resolution. lang-rust doesn't emit a FunctionDefinition
 * for anonymous closures, so the null is correct.
 *
 * Known limitations:
 *   - Methods inside `impl <Type> { fn name(...) }`. The flat regex
 *     captures `fn name` and stores it as a bare name — without
 *     `<Type>.name`. If a handler reference is `<Type>.name`, the
 *     lookup will miss. Real axum apps rarely use impl methods as
 *     handlers (the Handler trait wants regular async fns), so this
 *     is a v1 acceptable miss.
 *   - Functions inside inline `mod <ident> { … }` blocks are
 *     intentionally SKIPPED. lang-rust's structural pass does not
 *     recurse into mod_item bodies (`extract-source-file.ts` only
 *     emits FunctionDefinition for top-level `function_item` nodes).
 *     Lifting them here would mint dangling FunctionDefinition.id
 *     references — endpoints that point at no real node and silently
 *     dead-end flow walks. The scanner identifies mod-bodies via a
 *     brace-depth pass that respects comments and string literals.
 *     Functions in separate `<mod_name>.rs` files (the more common
 *     organisation for real codebases) are unaffected.
 *   - Rust generics `fn name<T>(...)` ARE handled — the regex
 *     accepts an optional `<...>` between name and `(`.
 */

export interface HandlerEntry {
  /** Function definition name as lang-rust emits it. */
  readonly name: string;
  /** Source-file path relative to rootDir. */
  readonly filePath: string;
  /** 1-indexed source line of the declaration. */
  readonly sourceLine: number;
}

export interface HandlerMap {
  /**
   * Lookup key → matching entry. Returns null when the lookup name
   * is ambiguous (more than one match) so the visitor falls back to
   * leaving `handlerFunctionId` null rather than picking arbitrarily.
   */
  readonly byName: ReadonlyMap<string, HandlerEntry | null>;
}

/**
 * Walk `rootDir` for `.rs` files and build the handler map. Returns
 * an empty map when no Rust source is found.
 */
export function buildAxumHandlerMap(rootDir: string): HandlerMap {
  const rustFiles = findRustFiles(rootDir);
  if (rustFiles.length === 0) return { byName: new Map() };

  const collected = new Map<string, HandlerEntry[]>();
  for (const abs of rustFiles) {
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const relPath = path.relative(rootDir, abs).split(path.sep).join('/');
    extractDeclarations(content, relPath, collected);
  }

  const byName = new Map<string, HandlerEntry | null>();
  for (const [name, entries] of collected) {
    byName.set(name, entries.length === 1 ? entries[0] : null);
  }
  return { byName };
}

// Matches `fn Name(...)`, `pub fn Name(...)`, `pub(crate) fn Name(...)`,
// `pub async fn Name<T>(...)`, etc. Captures: name.
//
// Anchor at line start (with optional indent) so `func` text inside a
// string literal or block comment can't false-match.
const RUST_FN_RE =
  /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+([A-Za-z_][\w]*)(?:\s*<[^>]*>)?\s*\(/gm;

function extractDeclarations(
  content: string,
  filePath: string,
  out: Map<string, HandlerEntry[]>,
): void {
  // Compute the byte-offset span of every `mod <ident> { … }` body
  // so we can skip fn declarations nested inside them. lang-rust's
  // structural pass doesn't recurse into `mod_item` bodies — it only
  // emits FunctionDefinition for top-level `function_item` nodes.
  // If the resolver lifted a module-nested fn it would mint a
  // dangling FunctionDefinition.id that points at no real node, and
  // the flow walker would silently try to BFS from a non-existent
  // function. (Reviewer caught this against the `orders::list`
  // case in tests/fixtures/rust/axum/handlers.rs.)
  const modBodySpans = findModBodySpans(content);
  RUST_FN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RUST_FN_RE.exec(content)) !== null) {
    if (isOffsetInsideAnySpan(m.index, modBodySpans)) continue;
    const fnName = m[1]!;
    const sourceLine = lineNumberAtIndex(content, m.index);
    const entry: HandlerEntry = {
      name: fnName,
      filePath,
      sourceLine,
    };
    const list = out.get(fnName);
    if (list) list.push(entry);
    else out.set(fnName, [entry]);
  }
}

const MOD_OPEN_RE = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_][\w]*\s*\{/gm;

/**
 * Find the byte spans of every inline `mod <ident> { … }` body.
 * Returns an array of `{ start, end }` (start = byte offset of the
 * opening `{` + 1, end = byte offset of the matching `}`). Uses a
 * simple brace-depth scan that respects line/block comments and
 * single-line string literals — good enough for typical Rust source.
 *
 * `mod foo;` (no body) doesn't match and produces no span — those
 * are file-references, not inline modules with code in them.
 */
function findModBodySpans(content: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  MOD_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MOD_OPEN_RE.exec(content)) !== null) {
    const openBraceIdx = m.index + m[0].length - 1;
    const end = matchClosingBrace(content, openBraceIdx);
    if (end < 0) continue; // malformed — skip
    spans.push({ start: openBraceIdx + 1, end });
  }
  return spans;
}

/**
 * Given the offset of `{`, return the offset of the matching `}` or
 * -1 if not found. Skips contents of `//` line comments, block
 * comments (the `/star … star/` form), and `"…"` / `r"…"` / `r#"…"#`
 * string literals so braces inside those don't throw off the depth
 * counter.
 */
function matchClosingBrace(content: string, openBraceIdx: number): number {
  let depth = 1;
  let i = openBraceIdx + 1;
  while (i < content.length && depth > 0) {
    const ch = content[i]!;
    // Line comment.
    if (ch === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl < 0 ? content.length : nl + 1;
      continue;
    }
    // Block comment (non-nesting; nested block comments are rare).
    if (ch === '/' && content[i + 1] === '*') {
      const close = content.indexOf('*/', i + 2);
      i = close < 0 ? content.length : close + 2;
      continue;
    }
    // String literal (regular).
    if (ch === '"') {
      i = scanPastDoubleQuotedString(content, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function scanPastDoubleQuotedString(content: string, startIdx: number): number {
  let i = startIdx + 1;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"') return i + 1;
    i++;
  }
  return content.length;
}

function isOffsetInsideAnySpan(
  offset: number,
  spans: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  for (const span of spans) {
    if (offset >= span.start && offset < span.end) return true;
  }
  return false;
}

function lineNumberAtIndex(text: string, index: number): number {
  let count = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  // Rust convention: `target/` is the build output dir.
  'target',
]);

function findRustFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.rs')) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}
