import type { CanonicalGraphStore } from '@adorable/graph-db';
import type { NodeBatch } from '@adorable/plugin-api';
import type { CallsFunctionEdge, FunctionDefinition, SchemaEdge, SourceFile } from '@adorable/schema';
import { isHtmlSynthetic, isPerProcessSynthetic } from './synthetic-names.js';

/**
 * Resolve inline JS handler bodies to cross-file function references
 * (#173 piece B).
 *
 * After language extraction, every per-process synthetic FunctionDefinition
 * emitted by lang-html (e.g., `_button_click_L18_onclick`) has its
 * `evidence.snippet` set to the raw attribute text — `onclick="doLogin()"`.
 * This pass scans those snippets for identifier-call patterns and emits
 * `CALLS_FUNCTION` edges to matching FunctionDefinitions in the same
 * repository, so flow walking can chain
 *
 *   process → per-process fn → (CALLS_FUNCTION) → real JS fn → MAKES_REQUEST → caller
 *
 * Limitations (regex-based parsing — see #173 for the ts-morph upgrade path):
 *   - Method calls like `obj.method()` are skipped.
 *   - Nested function expressions (`(function(){doLogin()})()`) are flattened.
 *   - JS keywords (`if`, `function`, `return`, …) are filtered out, but
 *     identifiers shadowing globals (`Number(x)`) match the global list.
 *   - Ambiguous matches (multiple FunctionDefinitions with the same name)
 *     emit one edge per match — same behavior as the TS call-graph extractor
 *     for unresolvable overloads.
 */
export function resolveInlineHandlers(store: CanonicalGraphStore): NodeBatch {
  const newEdges: SchemaEdge[] = [];

  const allSourceFiles = store.findNodes('SourceFile') as SourceFile[];
  const sourceFileById = new Map(allSourceFiles.map((sf) => [sf.id, sf]));

  // Index real function definitions (not HTML-emitted synthetics) by
  // repository and name. lang-html emits two kinds of synthetics named
  // `_form_submit_L<line>` and `_<tag>_<event>_L<line>_<attr>` — emitting
  // CALLS_FUNCTION into those is never useful. We do NOT exclude
  // .vue / .ejs / .hbs files entirely though: lang-html now also emits
  // real Vue script-method stubs from those files (#173 piece C), and
  // those stubs ARE valid targets for template handler bindings.
  const fnByRepoAndName = new Map<string, Map<string, FunctionDefinition[]>>();
  const allFns = store.findNodes('FunctionDefinition') as FunctionDefinition[];
  for (const fn of allFns) {
    const sf = sourceFileById.get(fn.sourceFileId);
    if (!sf || isHtmlSynthetic(fn.name)) continue;

    let byName = fnByRepoAndName.get(sf.repository);
    if (!byName) {
      byName = new Map();
      fnByRepoAndName.set(sf.repository, byName);
    }
    let list = byName.get(fn.name);
    if (!list) {
      list = [];
      byName.set(fn.name, list);
    }
    list.push(fn);
  }

  // Walk synthetic per-process fns AND Vue-script method stubs, resolving
  // calls in their evidence.snippet. Two flavours of resolver target:
  //
  //   (1) Per-process synthetic fns (`_button_click_L18_onclick`) — snippet
  //       is the raw attribute text (`onclick="doLogin()"`).
  //   (2) Vue-script method stubs — snippet is the method body extracted
  //       from a `<script setup>` block (Fix 5). Lets `handleCancel()` in a
  //       Vue SFC chain into `cancelOrder()` defined in a sibling `.ts`
  //       file, so flow walking can reach the ClientSideAPICaller through
  //       the canonical CALLS_FUNCTION graph.
  //
  // The synthetic-name predicate isolates (1); for (2) we accept any
  // FunctionDefinition that lives in a `.vue` SourceFile, is not itself
  // a synthetic, and has an evidence.snippet.
  for (const fn of allFns) {
    const sf = sourceFileById.get(fn.sourceFileId);
    if (!sf) continue;

    const isPerProc = isPerProcessSynthetic(fn.name);
    const isSfcStub =
      !isHtmlSynthetic(fn.name) &&
      (sf.language === 'vue' || sf.language === 'svelte') &&
      (fn.evidence?.snippet ?? '') !== '';
    if (!isPerProc && !isSfcStub) continue;

    const snippet = fn.evidence?.snippet ?? '';
    const callNames = extractCallNames(snippet);
    if (callNames.length === 0) continue;

    const byName = fnByRepoAndName.get(sf.repository);
    if (!byName) continue;

    for (const callName of callNames) {
      const targets = byName.get(callName);
      if (!targets) continue;
      for (const target of targets) {
        // Skip the literal self-loop. We intentionally do NOT skip on
        // `callName === fn.name`: when several FunctionDefinitions in
        // the same repo share a name (e.g., a Vue method calling a
        // sibling helper that also exists in another file), we want
        // edges to ALL siblings — the documented ambiguous-match
        // fan-out — and only suppress the fn-to-itself edge.
        if (target.id === fn.id) continue;
        newEdges.push({
          edgeType: 'CALLS_FUNCTION',
          from: fn.id,
          to: target.id,
          sourceLine: fn.sourceLine,
          arguments: [],
          isConditional: false,
          confidence: 'direct',
        } as CallsFunctionEdge);
      }
    }
  }

  return { nodes: [], edges: newEdges };
}

/**
 * Extract bare identifier-call sites from an inline-handler attribute snippet.
 *   `onclick="doLogin()"`                    → ['doLogin']
 *   `onclick="track('signup'); openHelp()"`  → ['track', 'openHelp']
 *   `onclick="user.logout()"`                → []           (method call — receiver-bound)
 *   `onclick="if (validate()) doLogin()"`    → ['validate', 'doLogin']  (`if` filtered)
 *   `@click="onSubmit"`                      → ['onSubmit'] (Vue / Angular bare-ref shorthand —
 *                                                            framework calls it implicitly)
 */
export function extractCallNames(text: string): string[] {
  const names = new Set<string>();

  // Pattern 1: `identifier(` — vanilla call sites. Negative lookbehind on
  // `.` skips `obj.method()` calls. The `[\w$]` lookbehind term avoids
  // re-attempting matches mid-identifier.
  const CALL_RE = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(text)) !== null) {
    const name = m[1];
    if (!JS_KEYWORDS.has(name)) names.add(name);
  }

  // Pattern 2: attribute value is exactly a bare identifier — `@click="onSubmit"`.
  // Vue passes the event implicitly; Angular accepts this as a reference too.
  // Plain HTML `onclick="someFn"` is rare but legal and treated the same.
  const BARE_VALUE_RE = /=\s*["']\s*([A-Za-z_$][\w$]*)\s*["']/g;
  while ((m = BARE_VALUE_RE.exec(text)) !== null) {
    const name = m[1];
    if (!JS_KEYWORDS.has(name)) names.add(name);
  }

  // Pattern 3: Svelte/Vue curly-binding to a bare handler ref —
  // `on:click={handleCancel}`. Svelte template values use `={…}`
  // (sometimes wrapped in `"…"` by lang-html's SFC preprocessor so
  // tree-sitter-html captures the value through inner `>` chars).
  // Match both shapes: `={X}` and `="{X}"` / `='{X}'`.
  //
  // Restricted to attribute-shaped inputs: the `=` must be preceded
  // by an identifier of attribute shape (letters/digits/`-`/`:`/`|`)
  // — `on:click=`, `bind:value=`, `disabled=`. This excludes plain
  // JS assignments like `state = {user}` or `return {data}` that
  // would otherwise emit spurious CALLS_FUNCTION edges when the
  // resolver scans a Vue/Svelte script stub body.
  const SVELTE_BARE_RE = /(?<![\w$])[A-Za-z][\w:|-]*\s*=\s*["']?\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*["']?/g;
  while ((m = SVELTE_BARE_RE.exec(text)) !== null) {
    const name = m[1];
    if (!JS_KEYWORDS.has(name)) names.add(name);
  }

  return [...names];
}

/**
 * JS keywords that can syntactically appear before a `(` but aren't
 * function calls. Trimmed to the set we actually see in HTML attribute
 * values; expand if real-world fixtures show drift.
 */
const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return',
  'void', 'typeof', 'instanceof', 'new', 'delete', 'in', 'of',
  'function', 'var', 'let', 'const', 'try', 'catch', 'finally',
  'throw', 'async', 'await', 'yield', 'class', 'true', 'false',
  'null', 'undefined', 'this', 'super',
]);
