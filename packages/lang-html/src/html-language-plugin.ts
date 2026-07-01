import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguagePlugin, FrameworkVisitor, ProjectHandle, ProjectOptions, NodeBatch } from '@adorable/plugin-api';

export const HTML_PLUGIN_ID = 'html' as const;
/**
 * Extensions handled by lang-html (#170, #183):
 *   - `.html` / `.htm`            — vanilla HTML and Angular component templates (Phase 1, 2)
 *   - `.vue`                      — Vue single-file components (Phase 3)
 *   - `.ejs` / `.hbs` / `.handlebars` — server-rendered templates (Phase 4)
 *   - `.njk` / `.j2` / `.jinja` / `.jinja2` — Nunjucks and Jinja(2) templates (#183)
 *   - `.twig`                     — Symfony / Drupal Twig templates (#183)
 *   - `.liquid`                   — Shopify / Jekyll Liquid templates (#183)
 *   - `.mustache`                 — Mustache templates (#183)
 *
 * All Jinja-family engines share an HTML body with `{% ... %}` and
 * `{{ ... }}` directives that tree-sitter-html safely treats as text
 * content; the visitor extracts `<a>`, `<script>`, `<form>`, etc.
 * the same way it does for plain HTML, which is the primary value
 * for navigation / endpoint analysis.
 *
 * `.pug` is intentionally excluded — its whitespace-significant syntax
 * does not parse with tree-sitter-html.
 */
export const HTML_FILE_EXTENSIONS = [
  '.html',
  '.htm',
  '.vue',
  '.svelte',
  '.ejs',
  '.hbs',
  '.handlebars',
  '.njk',
  '.j2',
  '.jinja',
  '.jinja2',
  '.twig',
  '.liquid',
  '.mustache',
] as const;

import type Parser from 'web-tree-sitter';

let TreeSitter: typeof Parser | null = null;
let HtmlLanguage: Parser.Language | null = null;

async function ensureParser(): Promise<void> {
  if (TreeSitter && HtmlLanguage) return;
  const mod = await import('web-tree-sitter');
  TreeSitter = mod.default;
  await TreeSitter.init();

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  const wasmPath = path.join(wasmsDir, 'out', 'tree-sitter-html.wasm');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`tree-sitter-html.wasm not found at ${wasmPath}`);
  }

  HtmlLanguage = await TreeSitter.Language.load(wasmPath);
}

interface HtmlProjectInternal {
  rootDir: string;
  repository: string;
}

const projectHandleBrand: unique symbol = Symbol('HtmlProjectHandle');

function makeHandle(internal: HtmlProjectInternal): ProjectHandle {
  return { [projectHandleBrand]: true, ...internal } as unknown as ProjectHandle;
}

function unwrapHandle(handle: ProjectHandle): HtmlProjectInternal {
  return handle as unknown as HtmlProjectInternal;
}

export class HtmlLanguagePlugin implements LanguagePlugin {
  readonly id = HTML_PLUGIN_ID;
  readonly fileExtensions = HTML_FILE_EXTENSIONS;

  async loadProject(opts: ProjectOptions): Promise<ProjectHandle> {
    await ensureParser();
    return makeHandle({
      rootDir: path.resolve(opts.rootDir),
      repository: opts.repository ?? path.basename(opts.rootDir),
    });
  }

  async extractFile(project: ProjectHandle, filePath: string): Promise<NodeBatch> {
    const internal = unwrapHandle(project);
    const absPath = path.resolve(internal.rootDir, filePath);
    const safeRoot = internal.rootDir.endsWith(path.sep) ? internal.rootDir : internal.rootDir + path.sep;
    if (!absPath.startsWith(safeRoot) && absPath !== internal.rootDir) {
      throw new Error(`Path traversal denied: ${filePath}`);
    }
    const rawSource = fs.readFileSync(absPath, 'utf-8');
    // Svelte and Vue allow unquoted brace-expression attribute values
    // — `on:click={() => handler()}`. tree-sitter-html follows the
    // bare-HTML rule that `>` terminates the start tag, so any `=>`
    // inside such a value silently truncates the attribute. Pre-wrap
    // those values in quotes so the parser captures them whole. The
    // wrap is byte-preserving (replaces `={` with `="{` and inserts
    // the closing `"` right after the matching `}`), so attr.node text
    // includes the full expression and downstream call-name extraction
    // can see the handler reference.
    const source = filePath.toLowerCase().endsWith('.svelte') || filePath.toLowerCase().endsWith('.vue')
      ? quoteBraceAttrValues(rawSource)
      : rawSource;

    const parser = new TreeSitter!();
    parser.setLanguage(HtmlLanguage!);
    const tree = parser.parse(source);

    const { extractHtmlFile } = await import('./extract-source-file.js');
    return extractHtmlFile(tree, filePath, internal.repository);
  }

  registerVisitor(visitor: FrameworkVisitor): void {
    // Reject mis-typed visitors early. lang-html does not yet expose a
    // public visitor surface — Angular and Vue template extraction is
    // currently inline in the structural extractor. Cross-file template
    // → component-method resolution is tracked in #173, and a real
    // visitor surface may follow once that work is scoped.
    if (visitor.language !== 'html') {
      throw new Error(`HtmlLanguagePlugin: visitor language must be 'html', got '${visitor.language}'`);
    }
    throw new Error("HtmlLanguagePlugin: no visitor surface yet — see #173 for the framework-visitor extension plan");
  }
}

/**
 * Pre-process a Svelte or Vue SFC source so tree-sitter-html captures
 * brace-expression attribute values (`on:click={handler}`,
 * `bind:value={state}`, `={() => handler()}`) intact.
 *
 * Vanilla HTML attributes follow the rule that `>` terminates the
 * start tag, so an unquoted value containing `=>` (very common in
 * Svelte arrow handlers) silently truncates. Wrapping `={…}` in
 * double quotes makes tree-sitter-html treat the whole brace
 * expression as a quoted attribute value, so the raw text reaches
 * `extractCallNames` / `resolveInlineHandlers` whole.
 *
 * Implementation: walk the source, identify each `=` that's followed
 * (modulo whitespace) by `{`, find the matching `}` via brace-depth
 * scan, and splice quotes in. Brace-depth tracking respects nested
 * strings and template literals so a `}` inside a string doesn't
 * close early. Byte length grows by 2 per attribute (the two added
 * quotes); line numbers stay aligned because we don't insert newlines.
 */
function quoteBraceAttrValues(source: string): string {
  const out: string[] = [];
  let i = 0;
  const N = source.length;
  while (i < N) {
    const ch = source[i]!;
    // Skip `<!-- … -->` comments verbatim — their contents may contain
    // `={…}` patterns (`<!-- on:foo={x} -->`) that are NOT real
    // attribute values, and rewriting them would corrupt the comment
    // and potentially the surrounding source if the brace counter
    // mis-balances.
    if (ch === '<' && source[i + 1] === '!' && source[i + 2] === '-' && source[i + 3] === '-') {
      const close = source.indexOf('-->', i + 4);
      const end = close < 0 ? N : close + 3;
      for (let k = i; k < end; k++) out.push(source[k]!);
      i = end;
      continue;
    }
    // Skip `<script>` and `<style>` blocks verbatim — their bodies are
    // JS/TS or CSS, not HTML, so we must not enter "inside tag" mode
    // on a stray `<identifier` (`if (x<y) { obj = {k:1}; }`) which
    // would otherwise rewrite the script's object literal as if it
    // were an attribute value. Read the opening tag fully, then echo
    // the body up to the closing `</script>` / `</style>`.
    if (ch === '<' && isRawTextTagStart(source, i)) {
      const tagName = readTagName(source, i + 1);
      // Echo the opening tag through its closing `>`.
      const tagClose = source.indexOf('>', i);
      const tagEnd = tagClose < 0 ? N : tagClose + 1;
      for (let k = i; k < tagEnd; k++) out.push(source[k]!);
      i = tagEnd;
      // Locate the matching `</tagName>` (case-insensitive).
      const endRe = new RegExp(`</\\s*${tagName}\\s*>`, 'i');
      const rest = source.slice(i);
      const m = endRe.exec(rest);
      const bodyEnd = m ? i + m.index + m[0].length : N;
      for (let k = i; k < bodyEnd; k++) out.push(source[k]!);
      i = bodyEnd;
      continue;
    }
    // Only attempt the rewrite inside a start-tag context. The cheap
    // signal: a `<` followed by a letter or `/` indicates a tag opener;
    // once we find one we walk to the matching `>` looking for `=`
    // followed by `{`. We don't try to be precise about quoted-value
    // skipping inside the tag — strings inside attribute values would
    // already terminate at the first `"`, and we only rewrite UNQUOTED
    // `={…}` values, so other quoting can be left alone.
    if (ch !== '<' || !/[A-Za-z!/]/.test(source[i + 1] ?? '')) {
      out.push(ch);
      i++;
      continue;
    }
    // Walk inside the start tag. Snapshot both the source position
    // (`tagStart`) and the output length (`outAtTagStart`) so the
    // never-closed-tag fallback below truncates `out` correctly even
    // when earlier rewrites have inserted extra quote chars.
    const tagStart = i;
    const outAtTagStart = out.length;
    out.push(ch);
    i++;
    while (i < N) {
      const c = source[i]!;
      if (c === '>') { out.push(c); i++; break; }
      if (c === '"') {
        // Skip quoted attribute value verbatim — no rewrite needed.
        out.push(c);
        i++;
        while (i < N && source[i] !== '"') {
          out.push(source[i]!);
          i++;
        }
        if (i < N) { out.push(source[i]!); i++; }
        continue;
      }
      if (c === "'") {
        out.push(c);
        i++;
        while (i < N && source[i] !== "'") {
          out.push(source[i]!);
          i++;
        }
        if (i < N) { out.push(source[i]!); i++; }
        continue;
      }
      if (c === '=' && peekNonWhitespace(source, i + 1) === '{') {
        // Find the `{` and its matching `}`. Whitespace between `=` and
        // `{` may include `\n` — Prettier-svelte sometimes breaks lines
        // after `=` on long handler chains — so allow it. Newlines
        // preserved verbatim so line numbers in downstream evidence
        // stay correct.
        out.push('=');
        i++;
        while (i < N && /\s/.test(source[i]!) && source[i] !== '{') {
          out.push(source[i]!);
          i++;
        }
        if (source[i] !== '{') continue;
        // Insert opening quote, then the `{`.
        out.push('"');
        out.push('{');
        i++;
        // Walk to matching `}`, respecting nested strings.
        let depth = 1;
        while (i < N && depth > 0) {
          const cc = source[i]!;
          if (cc === '"' || cc === "'" || cc === '`') {
            out.push(cc);
            i++;
            const quote = cc;
            while (i < N && source[i] !== quote) {
              if (source[i] === '\\') {
                out.push(source[i]!);
                i++;
                if (i < N) { out.push(source[i]!); i++; }
                continue;
              }
              out.push(source[i]!);
              i++;
            }
            if (i < N) { out.push(source[i]!); i++; }
            continue;
          }
          if (cc === '{') depth++;
          else if (cc === '}') depth--;
          if (depth === 0) {
            // Insert closing quote AFTER the closing `}`.
            out.push('}');
            out.push('"');
            i++;
            break;
          }
          out.push(cc);
          i++;
        }
        continue;
      }
      out.push(c);
      i++;
    }
    if (i >= N) {
      // Tag never closed — fall back to the original substring to
      // avoid losing content. Should be unreachable on well-formed
      // SFCs. Truncate `out` to its length at tag-entry (NOT to the
      // source position, which doesn't account for `"` chars already
      // inserted by earlier rewrites) and then append the raw tail.
      out.length = outAtTagStart;
      out.push(source.slice(tagStart));
      break;
    }
  }
  return out.join('');
}

function peekNonWhitespace(text: string, start: number): string | null {
  let i = start;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i < text.length ? text[i]! : null;
}

const RAW_TEXT_TAGS = new Set(['script', 'style']);

function isRawTextTagStart(source: string, atLt: number): boolean {
  // Expect `<TAG[ />]` (no leading `/`). The `</...>` close form is
  // handled by the regular tag walker — we only treat the *opening*
  // `<script>` / `<style>` specially.
  if (source[atLt] !== '<') return false;
  if (source[atLt + 1] === '/') return false;
  const name = readTagName(source, atLt + 1).toLowerCase();
  return RAW_TEXT_TAGS.has(name);
}

function readTagName(source: string, start: number): string {
  let i = start;
  while (i < source.length && /[A-Za-z0-9-]/.test(source[i]!)) i++;
  return source.slice(start, i);
}
