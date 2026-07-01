import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonicalGraphStore } from '@veoable/graph-db';
import type { NodeBatch } from '@veoable/plugin-api';
import type { CallsFunctionEdge, FunctionDefinition, SourceFile } from '@veoable/schema';

/**
 * Cross-module CALLS_FUNCTION resolver for Rust (#546).
 *
 * `extract-source-file` emits CALLS_FUNCTION edges only for calls whose
 * callee resolves in the same file's `fnByName` index. A cross-module
 * call like
 *
 *     // routes.rs
 *     async fn cancel_order(...) {
 *         orders::cancel(&state, &id).await?;
 *     }
 *
 *     // orders.rs
 *     pub async fn cancel(...) { ... }
 *
 * gets no edge today, so the flow walker BFS from `cancel_order` stops
 * before reaching the `DatabaseInteraction` that `orders::cancel`
 * actually performs.
 *
 * This post-pass scans every .rs file once, builds:
 *   1. A project-wide symbol map keyed by `(modulePath, name)` from
 *      the FunctionDefinitions already emitted during extraction.
 *   2. A per-file `use_declaration` table mapping bare identifiers to
 *      their resolved module paths.
 *
 * Then resolves two call shapes (covers the bulk of real-world apps):
 *   1. Scoped: `orders::cancel(...)` → look up `(orders, cancel)`.
 *   2. Use-resolved bare: `cancel(...)` after `use orders::cancel;`
 *      → resolve `cancel` via the use-table, then look up `(orders, cancel)`.
 *
 * Uniqueness gating: emit only when the lookup yields exactly one
 * FunctionDefinition (same policy as the axum/gin handler-resolvers).
 *
 * The caller of each call site is attributed to the innermost
 * FunctionDefinition whose `sourceLine`..`endLine` brace-balanced
 * range contains the call. Brace-balancing respects line and block
 * comments and string literals so braces inside those don't shift
 * the function boundaries.
 *
 * Cross-file edges only: when a call resolves to a function in the
 * SAME file, extract-source-file already emitted the edge — we skip
 * to avoid duplicates.
 *
 * Known limitations (documented up front; out of scope for v1):
 *   - `impl <Type> { fn name(...) }` methods (associated functions
 *     and methods) — the method's stored name is `Type.name`; this
 *     resolver only handles free-function calls.
 *   - Inline `mod foo { fn bar() {} }` bodies — lang-rust's
 *     structural pass doesn't emit FunctionDefinitions for them, so
 *     lifting them here would mint dangling edges. The brace-depth
 *     scan skips these.
 *   - Aliased imports (`use foo::bar as baz;`) — the alias mapping
 *     is intentionally skipped; the call site `baz(...)` doesn't
 *     resolve, falling back to no-edge. Documented; future work.
 *   - Relative paths (`use super::foo;`, `use self::foo;`) — same
 *     no-resolve fallback.
 *   - Glob imports (`use foo::*;`) — same.
 *   - Trait-method receivers (`state.cancel(&id)`) — type inference
 *     is out of scope for a regex pass.
 *   - Macro-expanded calls — opaque to the scanner.
 *   - `pub use` re-exports — a function defined in module A and
 *     re-exported by module B (`pub use a::foo;`) is only resolvable
 *     under the A-rooted path. A call site that imports via B
 *     (`use b::foo;`) currently falls back to no-edge.
 */

export function resolveRustCrossModCalls(
  store: CanonicalGraphStore,
  rootDir: string,
): NodeBatch {
  // Cheap guard: skip the disk walk entirely when no Rust source has
  // been extracted into the graph. A non-Rust project would otherwise
  // pay the I/O cost of a full directory traversal for no benefit.
  const allSourceFiles = store.findNodes('SourceFile') as SourceFile[];
  const hasRust = allSourceFiles.some((sf) => sf.language === 'rust');
  if (!hasRust) return { nodes: [], edges: [] };

  const rustFiles = findRustFiles(rootDir);
  if (rustFiles.length === 0) return { nodes: [], edges: [] };

  // ── Step 1: index existing FunctionDefinitions by repo + path ──
  const allFns = store.findNodes('FunctionDefinition') as FunctionDefinition[];
  const sourceFileById = new Map(allSourceFiles.map((sf) => [sf.id, sf]));

  // Per-repo symbol index keyed by `${modulePath}::${name}` (or just
  // `name` at the crate root). Length-1 entries are unique matches;
  // length > 1 means ambiguous and the resolver skips emitting.
  interface RepoIndex {
    byPath: Map<string, FunctionDefinition[]>;
  }
  const indexByRepo = new Map<string, RepoIndex>();

  for (const fn of allFns) {
    const sf = sourceFileById.get(fn.sourceFileId);
    if (!sf || sf.language !== 'rust') continue;
    // Skip names emitted in impl blocks (`Type.name` form) — those are
    // associated functions / methods, not free fns. Free fn names
    // never contain a `.` per lang-rust's emission contract.
    if (fn.name.includes('.')) continue;
    const modulePath = modulePathFromFile(sf.filePath);
    const fullPath = modulePath ? `${modulePath}::${fn.name}` : fn.name;

    let idx = indexByRepo.get(sf.repository);
    if (!idx) {
      idx = { byPath: new Map() };
      indexByRepo.set(sf.repository, idx);
    }

    const byPathList = idx.byPath.get(fullPath);
    if (byPathList) byPathList.push(fn);
    else idx.byPath.set(fullPath, [fn]);
  }

  // ── Step 2: scan every .rs file, resolve calls ──
  const newEdges: CallsFunctionEdge[] = [];
  // Map a filePath (POSIX-style relative to rootDir) to its SourceFile.
  const sourceFileByPath = new Map<string, SourceFile>();
  for (const sf of allSourceFiles) {
    if (sf.language === 'rust') sourceFileByPath.set(sf.filePath, sf);
  }
  // For dedup: existing CALLS_FUNCTION edges keyed by `${from}|${to}|${line}`.
  const existingEdgeKey = new Set<string>();
  const existingEdges = store.findEdges(null, null, 'CALLS_FUNCTION');
  for (const e of existingEdges) {
    const key = `${e.from}|${e.to}|${'sourceLine' in e ? e.sourceLine : ''}`;
    existingEdgeKey.add(key);
  }

  for (const abs of rustFiles) {
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const relPath = path.relative(rootDir, abs).split(path.sep).join('/');
    const sf = sourceFileByPath.get(relPath);
    if (!sf) continue;
    const repoIdx = indexByRepo.get(sf.repository);
    if (!repoIdx) continue;

    const scan = scanRustFile(content);
    // Caller attribution: for each call site's line, find the innermost
    // FunctionDefinition (by start..end range) it falls within.
    const callersByLine = (line: number): FunctionDefinition | null => {
      let best: { fn: FunctionDefinition; span: number } | null = null;
      for (const fnRange of scan.fnRanges) {
        if (line < fnRange.startLine || line > fnRange.endLine) continue;
        const fnDef = findFunctionDefinition(allFns, sf.id, fnRange.name, fnRange.startLine);
        if (!fnDef) continue;
        const span = fnRange.endLine - fnRange.startLine;
        if (!best || span < best.span) best = { fn: fnDef, span };
      }
      return best ? best.fn : null;
    };

    for (const call of scan.calls) {
      const caller = callersByLine(call.line);
      if (!caller) continue;

      const targets = resolveCallee(call, scan.useTable, repoIdx);
      if (targets.length !== 1) continue; // ambiguous or unresolved
      const target = targets[0]!;

      // Skip same-file edges — extract-source-file handles those.
      if (target.sourceFileId === caller.sourceFileId) continue;

      const key = `${caller.id}|${target.id}|${call.line}`;
      if (existingEdgeKey.has(key)) continue;
      existingEdgeKey.add(key);

      newEdges.push({
        edgeType: 'CALLS_FUNCTION',
        from: caller.id,
        to: target.id,
        sourceLine: call.line,
        arguments: [],
        isConditional: false,
        confidence: 'direct',
      });
    }
  }

  return { nodes: [], edges: newEdges };
}

/**
 * Resolve a call site's callee against the per-file use-table and the
 * repo-wide symbol index. Returns the matching FunctionDefinitions —
 * empty when unresolved, length-1 when unique, length-N for ambiguous.
 */
function resolveCallee(
  call: ScannedCall,
  useTable: ReadonlyMap<string, string>,
  repoIdx: { byPath: Map<string, FunctionDefinition[]> },
): FunctionDefinition[] {
  if (call.kind === 'scoped') {
    // Strip leading `crate::` or `self::` so the path matches our
    // modulePath convention (paths anchored at the crate root with
    // no prefix).
    let callPath = call.path;
    if (callPath.startsWith('crate::')) callPath = callPath.slice('crate::'.length);
    else if (callPath.startsWith('self::')) callPath = callPath.slice('self::'.length);
    const fullPath = `${callPath}::${call.name}`;
    return repoIdx.byPath.get(fullPath) ?? [];
  }
  // Bare identifier — only resolves if it's mapped in the use-table.
  // We don't fall back to bare-name lookup because that would emit
  // spurious cross-file edges for any same-named function.
  const usePath = useTable.get(call.name);
  if (!usePath) return [];
  return repoIdx.byPath.get(usePath) ?? [];
}

/**
 * Map a SourceFile's POSIX relative path to its Rust module path
 * (anchored at the crate root). Examples:
 *
 *   `backend/src/lib.rs`               → ``
 *   `backend/src/main.rs`              → ``
 *   `backend/src/orders.rs`            → `orders`
 *   `backend/src/orders/mod.rs`        → `orders`
 *   `backend/src/api/users.rs`         → `api::users`
 *   `backend/src/api/users/handlers.rs`→ `api::users::handlers`
 *
 * Stops at `src/` — segments before it (e.g. `backend/`) are the
 * Cargo crate root identifier and aren't part of the rust module
 * path. Multi-crate workspaces just see each crate independently.
 */
function modulePathFromFile(filePath: string): string {
  // Find the rightmost `src/`. Everything after it is the module path.
  // (Works for `backend/src/orders.rs`, `crates/foo/src/lib.rs`, etc.)
  const srcIdx = filePath.lastIndexOf('src/');
  if (srcIdx < 0) return '';
  const afterSrc = filePath.slice(srcIdx + 'src/'.length);
  // Strip `.rs`.
  const noExt = afterSrc.endsWith('.rs') ? afterSrc.slice(0, -3) : afterSrc;
  const segments = noExt.split('/');
  // Treat `lib`, `main` as crate-root: they have no module path.
  // Treat `mod` (e.g. `foo/mod.rs`) as the directory's module.
  const last = segments[segments.length - 1];
  if (last === 'lib' || last === 'main') {
    return segments.slice(0, -1).join('::');
  }
  if (last === 'mod') {
    return segments.slice(0, -1).join('::');
  }
  return segments.join('::');
}

interface FnRange {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface ScannedCall {
  readonly kind: 'scoped' | 'bare';
  readonly path: string; // empty for bare
  readonly name: string;
  readonly line: number;
}

interface RustFileScan {
  readonly fnRanges: ReadonlyArray<FnRange>;
  readonly useTable: ReadonlyMap<string, string>;
  readonly calls: ReadonlyArray<ScannedCall>;
}

/**
 * Regex-driven scan of a single .rs file's text. Produces:
 *   - `fnRanges`: every top-level `fn NAME(...) { ... }` with its
 *     brace-balanced line range. Functions inside inline `mod foo { … }`
 *     bodies are intentionally skipped (lang-rust's extractor doesn't
 *     emit FunctionDefinitions for them; emitting edges to those names
 *     would dangle).
 *   - `useTable`: identifier → resolved-path (from `use crate-or-mod::path::ident;`).
 *   - `calls`: every `path::name(` and `name(` call site with its
 *     1-based line number. Method calls (`a.b(`) and macro
 *     invocations (`name!(`) are skipped.
 */
function scanRustFile(content: string): RustFileScan {
  // Pre-mask line comments, block comments, and string literals to
  // spaces (preserving newlines so line numbers stay accurate). Without
  // this, `CALL_RE` on raw text would treat call-like syntax in
  // doc-comments (`/// Calls orders::cancel(id) — see RFC-42`) and
  // string literals (`"orders::cancel(id)"`) as real call sites and
  // emit phantom CALLS_FUNCTION edges. Masking happens first so every
  // downstream pass sees the same comment/string-free view of the
  // source.
  const masked = maskCommentsAndStrings(content);
  const lineStarts = computeLineStarts(content);
  // Functions inside `mod { … }` AND `impl <T> { … }` bodies are
  // skipped: lang-rust's extractor stores impl methods as `Type.name`
  // (not the bare regex name), so emitting a free-function range here
  // would mis-attribute calls inside the method body to a top-level
  // function of the same name that happens to live nearby.
  const skipSpans = [...findModBodySpans(masked), ...findImplBodySpans(masked)];
  const fnRanges = scanFnRanges(masked, skipSpans, lineStarts);
  const useTable = scanUseTable(masked);
  const calls = scanCalls(masked, skipSpans, lineStarts);
  return { fnRanges, useTable, calls };
}

/**
 * Replace `//` and `/star … star/` comments and `"…"` / `'…'` string
 * literals with spaces. Newlines inside multi-line constructs are
 * preserved so line numbers stay accurate when downstream regexes
 * scan the masked text. The original byte length is unchanged.
 */
function maskCommentsAndStrings(content: string): string {
  const out = content.split('');
  let i = 0;
  const N = out.length;
  while (i < N) {
    const ch = out[i]!;
    if (ch === '/' && out[i + 1] === '/') {
      // Line comment: blank through end-of-line (keep the `\n`).
      const nl = content.indexOf('\n', i);
      const end = nl < 0 ? N : nl;
      for (let k = i; k < end; k++) out[k] = ' ';
      i = end;
      continue;
    }
    if (ch === '/' && out[i + 1] === '*') {
      // Rust permits nested block comments (`/* /* */ */`). Track
      // depth so the outer `*/` is the one we stop at.
      let depth = 1;
      let j = i + 2;
      while (j < N && depth > 0) {
        if (out[j] === '/' && out[j + 1] === '*') { depth++; j += 2; continue; }
        if (out[j] === '*' && out[j + 1] === '/') { depth--; j += 2; continue; }
        j++;
      }
      for (let k = i; k < j; k++) {
        if (out[k] !== '\n') out[k] = ' ';
      }
      i = j;
      continue;
    }
    // Raw strings: `r"…"`, `r#"…"#`, `r##"…"##`, plus `br…` byte
    // variants. The number of `#`s on the close side matches the
    // open side, so `"` inside the body doesn't terminate the
    // literal. Handle these before the plain `"` branch.
    if ((ch === 'r' || (ch === 'b' && out[i + 1] === 'r')) && isRawStringStart(out, i)) {
      const startOfQuote = ch === 'r' ? i + 1 : i + 2;
      let hashCount = 0;
      let k = startOfQuote;
      while (k < N && out[k] === '#') { hashCount++; k++; }
      if (out[k] === '"') {
        let j = k + 1;
        while (j < N) {
          if (out[j] === '"') {
            let h = 0;
            while (h < hashCount && out[j + 1 + h] === '#') h++;
            if (h === hashCount) { j = j + 1 + hashCount; break; }
          }
          j++;
        }
        for (let p = i; p < j; p++) {
          if (out[p] !== '\n') out[p] = ' ';
        }
        i = j;
        continue;
      }
    }
    if (ch === '"' || (ch === 'b' && out[i + 1] === '"')) {
      // Plain string or byte string (`"…"` / `b"…"`). Walk to
      // closing `"`, respecting `\\` escapes.
      const startQuote = ch === '"' ? i : i + 1;
      let j = startQuote + 1;
      while (j < N) {
        if (out[j] === '\\') { j += 2; continue; }
        if (out[j] === '"') { j++; break; }
        j++;
      }
      // Blank the literal body. Keep the quotes so the regex's
      // negative-lookbehind class still sees a non-identifier char.
      for (let k = startQuote + 1; k < j - 1; k++) {
        if (out[k] !== '\n') out[k] = ' ';
      }
      i = j;
      continue;
    }
    if (ch === "'") {
      // Could be a char literal (`'a'`, `'\n'`, `'\u{1234}'`,
      // `b'a'`) or a lifetime (`'static`, `'a`). Distinguish by
      // peeking ahead for the closing `'`. Bound the scan to a
      // small window so a lifetime doesn't cause us to swallow
      // arbitrary code.
      const close = findCharLiteralClose(content, i);
      if (close > i) {
        for (let k = i; k <= close; k++) {
          if (out[k] !== '\n') out[k] = ' ';
        }
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Is the byte at `i` the start of a Rust raw string literal? Rust
 * only treats `r` / `br` followed by `#*"` as a raw string when the
 * preceding token is not an identifier — otherwise it could be the
 * identifier `r` or `br` followed by something else.
 */
function isRawStringStart(out: ReadonlyArray<string>, i: number): boolean {
  // Walk past the `r` or `br` prefix to the `"` or `#`.
  const ch = out[i]!;
  let k = i + (ch === 'r' ? 1 : 2);
  while (out[k] === '#') k++;
  if (out[k] !== '"') return false;
  // Reject false positives where `r` is part of a longer identifier.
  const prev = i > 0 ? out[i - 1]! : '';
  if (/[A-Za-z0-9_$]/.test(prev)) return false;
  return true;
}

/**
 * Find the closing `'` of a char literal starting at `start`. Returns
 * `-1` if the `'` is a lifetime (no matching close within a small
 * lookahead). The valid char-literal shapes we care about:
 *   `'a'`            (single char)
 *   `'\n'` / `'\\'`  (escape)
 *   `'\u{1234}'`     (unicode escape, up to 10 chars inside)
 *   `'\x7f'`         (hex escape)
 */
function findCharLiteralClose(content: string, start: number): number {
  const N = content.length;
  // Hard cap: a Rust char literal body never exceeds ~12 chars.
  const maxEnd = Math.min(start + 16, N - 1);
  let i = start + 1;
  if (i >= N) return -1;
  if (content[i] === '\\') {
    // Escape sequences come in several flavours:
    //   `\n`, `\t`, `\r`, `\\`, `\'`, `\"`, `\0`  — single-char (4-byte literal)
    //   `\xNN`                                    — hex escape   (6-byte literal)
    //   `\u{NNNN}`                                — unicode      (variable)
    // Walk to the close quote rather than guessing the body length.
    i++;
    if (content[i] === 'u' && content[i + 1] === '{') {
      const close = content.indexOf('}', i + 2);
      if (close < 0 || close > maxEnd) return -1;
      i = close + 1;
    } else if (content[i] === 'x') {
      i++; // past `x`
      // Two hex digits.
      if (i + 1 < N && /[0-9A-Fa-f]/.test(content[i]!) && /[0-9A-Fa-f]/.test(content[i + 1]!)) {
        i += 2;
      }
    } else {
      i++; // single-char escape body (`n`, `t`, `\\`, `'`, etc.)
    }
  } else {
    i++;
  }
  if (i > maxEnd) return -1;
  return content[i] === "'" ? i : -1;
}

/**
 * Precompute the byte offsets of each line's start so per-call line
 * lookups are O(log N) instead of O(N). For a file with thousands of
 * call sites this turns a quadratic scan into a linear one.
 */
function computeLineStarts(content: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) out.push(i + 1);
  }
  return out;
}

function lineFromStarts(lineStarts: ReadonlyArray<number>, offset: number): number {
  // Binary search: rightmost line-start ≤ offset.
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based line numbers.
}

const FN_RE =
  /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+([A-Za-z_][\w]*)(?:\s*<[^>]*>)?\s*\(/gm;

function scanFnRanges(
  content: string,
  modBodySpans: ReadonlyArray<{ start: number; end: number }>,
  lineStarts: ReadonlyArray<number>,
): FnRange[] {
  const out: FnRange[] = [];
  FN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_RE.exec(content)) !== null) {
    if (isOffsetInsideAnySpan(m.index, modBodySpans)) continue;
    const name = m[1]!;
    const startLine = lineFromStarts(lineStarts, m.index);
    // Find body `{` after the param list. Skip to `)` then to `{`.
    // Comments and strings have already been masked to spaces, so we
    // don't need to re-handle them here.
    const headerEnd = m.index + m[0].length - 1; // position of `(`
    const closeParen = matchBalancedParen(content, headerEnd);
    if (closeParen < 0) continue;
    let i = closeParen + 1;
    let depth = 0;
    while (i < content.length) {
      const ch = content[i]!;
      if (ch === '<' || ch === '(' || ch === '[') { depth++; i++; continue; }
      if (ch === '>' || ch === ')' || ch === ']') { if (depth > 0) depth--; i++; continue; }
      if (ch === '{' && depth === 0) break;
      if (ch === ';' && depth === 0) { i = -1; break; } // signature item — no body
      i++;
    }
    if (i < 0 || i >= content.length || content[i] !== '{') continue;
    const closeBrace = matchClosingBrace(content, i);
    if (closeBrace < 0) continue;
    const endLine = lineFromStarts(lineStarts, closeBrace);
    out.push({ name, startLine, endLine });
  }
  return out;
}

const USE_SINGLE_RE = /^\s*use\s+([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)+)\s*;/gm;
const USE_GROUP_RE = /^\s*use\s+([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*)\s*::\s*\{([^}]+)\}\s*;/gm;

/**
 * Parse `use_declaration` lines and produce identifier → resolved-path
 * mappings. Strips leading `crate::` / `self::` so paths match our
 * `modulePathFromFile` convention. Aliased imports (`as`), glob
 * (`*`), and `super::` paths are intentionally skipped; see the
 * top-of-file caveats.
 */
function scanUseTable(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;

  USE_SINGLE_RE.lastIndex = 0;
  while ((m = USE_SINGLE_RE.exec(content)) !== null) {
    const fullPath = stripCratePrefix(m[1]!);
    if (fullPath.includes(' as ')) continue;
    if (fullPath.includes('super::')) continue;
    if (fullPath.endsWith('::*')) continue;
    const lastSeg = fullPath.split('::').pop()!;
    if (!/^[A-Za-z_][\w]*$/.test(lastSeg)) continue;
    out.set(lastSeg, fullPath);
  }

  USE_GROUP_RE.lastIndex = 0;
  while ((m = USE_GROUP_RE.exec(content)) !== null) {
    const basePath = stripCratePrefix(m[1]!);
    if (basePath.includes('super::')) continue;
    for (const partRaw of m[2]!.split(',')) {
      const part = partRaw.trim();
      if (!part || part.includes(' as ') || part === '*' || part === 'self') continue;
      if (!/^[A-Za-z_][\w]*$/.test(part)) continue;
      out.set(part, `${basePath}::${part}`);
    }
  }

  return out;
}

function stripCratePrefix(path: string): string {
  if (path.startsWith('crate::')) return path.slice('crate::'.length);
  if (path.startsWith('self::')) return path.slice('self::'.length);
  return path;
}

// Bare or scoped function call. Negative lookbehind on `.` skips
// method calls. Negative lookbehind on `!` (i.e. `\bname!(`) is
// handled implicitly — we look for the `(` to be the next significant
// token, not `!(`.
const CALL_RE =
  /(?<![.\w$])((?:[A-Za-z_][\w]*::)+)?([A-Za-z_][\w]*)\s*(\(|!)/g;

function scanCalls(
  content: string,
  modBodySpans: ReadonlyArray<{ start: number; end: number }>,
  lineStarts: ReadonlyArray<number>,
): ScannedCall[] {
  const out: ScannedCall[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(content)) !== null) {
    if (isOffsetInsideAnySpan(m.index, modBodySpans)) continue;
    const trailer = m[3]!;
    if (trailer === '!') continue; // macro invocation, not a function call
    // Skip function-declaration headers: `fn NAME(` is not a call.
    // CALL_RE happily matches `NAME(` and would otherwise yield a
    // phantom call edge from the declaring fn to anything that
    // resolves to NAME. The lookback is bounded so we don't scan the
    // entire file.
    if (isFnDeclarationHeader(content, m.index)) continue;
    const pathRaw = m[1] ?? '';
    const name = m[2]!;
    const line = lineFromStarts(lineStarts, m.index);
    if (pathRaw) {
      // Strip trailing `::`.
      const path = pathRaw.slice(0, -2);
      out.push({ kind: 'scoped', path, name, line });
    } else {
      out.push({ kind: 'bare', path: '', name, line });
    }
  }
  return out;
}

/**
 * True iff the character at `idx` is the start of a function
 * declaration's name (i.e. preceded by `fn` plus whitespace). Used
 * to suppress phantom call matches against `fn NAME(`.
 */
function isFnDeclarationHeader(content: string, idx: number): boolean {
  // Walk back over whitespace.
  let i = idx - 1;
  while (i >= 0 && (content[i] === ' ' || content[i] === '\t')) i--;
  // Expect `n` of `fn`.
  if (i < 1 || content[i] !== 'n' || content[i - 1] !== 'f') return false;
  // Confirm `fn` is its own token (no preceding identifier char).
  const before = i - 2 >= 0 ? content[i - 2]! : '';
  return !/[A-Za-z0-9_$]/.test(before);
}

// ─── shared brace / string scanners ───────────────────────────────────

const MOD_OPEN_RE = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_][\w]*\s*\{/gm;
// `impl <T>`, `impl <Type>`, `impl <T> for <U>`, `unsafe impl ...`, etc.
// We don't care about the type names — only the byte range of the
// body so `scanFnRanges` and `scanCalls` can skip its interior.
const IMPL_OPEN_RE = /^[ \t]*(?:unsafe\s+)?impl\b[^{;]*\{/gm;

function findModBodySpans(content: string): Array<{ start: number; end: number }> {
  return findBracedBodySpans(content, MOD_OPEN_RE);
}

function findImplBodySpans(content: string): Array<{ start: number; end: number }> {
  return findBracedBodySpans(content, IMPL_OPEN_RE);
}

function findBracedBodySpans(content: string, re: RegExp): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const openBraceIdx = m.index + m[0].length - 1;
    const end = matchClosingBrace(content, openBraceIdx);
    if (end < 0) continue;
    spans.push({ start: openBraceIdx + 1, end });
  }
  return spans;
}

function matchClosingBrace(content: string, openBraceIdx: number): number {
  let depth = 1;
  let i = openBraceIdx + 1;
  while (i < content.length && depth > 0) {
    const ch = content[i]!;
    if (ch === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl < 0 ? content.length : nl + 1;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const close = content.indexOf('*/', i + 2);
      i = close < 0 ? content.length : close + 2;
      continue;
    }
    if (ch === '"') { i = scanPastDoubleQuotedString(content, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function matchBalancedParen(content: string, openParenIdx: number): number {
  let depth = 1;
  let i = openParenIdx + 1;
  while (i < content.length && depth > 0) {
    const ch = content[i]!;
    if (ch === '"') { i = scanPastDoubleQuotedString(content, i); continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
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

const EXCLUDE_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', 'out', '.next', 'target',
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

/**
 * Pull the matching FunctionDefinition out of the global list by its
 * sourceFile + name + start line — there can be multiple fns with the
 * same name in the same file (declared in different scopes), so the
 * start-line is the disambiguator.
 */
function findFunctionDefinition(
  allFns: ReadonlyArray<FunctionDefinition>,
  sourceFileId: string,
  name: string,
  startLine: number,
): FunctionDefinition | null {
  for (const fn of allFns) {
    if (fn.sourceFileId === sourceFileId && fn.name === name && fn.sourceLine === startLine) {
      return fn;
    }
  }
  // Fallback: same file + name, prefer the closest sourceLine. Helpful
  // when the regex's anchor heuristic differs by a small number of
  // lines from tree-sitter's reported start line (e.g., attributes
  // above `fn`, doc-comments). Bounded to 10 lines so a name collision
  // between two unrelated fns in the same file can't silently re-attribute
  // a call to the wrong fn.
  const MAX_LINE_DRIFT = 10;
  let best: { fn: FunctionDefinition; distance: number } | null = null;
  for (const fn of allFns) {
    if (fn.sourceFileId !== sourceFileId || fn.name !== name) continue;
    const distance = Math.abs(fn.sourceLine - startLine);
    if (distance > MAX_LINE_DRIFT) continue;
    if (!best || distance < best.distance) best = { fn, distance };
  }
  return best ? best.fn : null;
}
