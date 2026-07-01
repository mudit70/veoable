import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
type Tree = Parser.Tree;
import {
  idFor,
  type SchemaNode,
  type SchemaEdge,
  type SourceFile,
  type FunctionDefinition,
  type ClientSideAPICaller,
  type ClientSideProcess,
  type Screen,
  type CallsFunctionEdge,
  type DefinedInEdge,
  type MakesRequestEdge,
  type NavigatesToEdge,
  type TriggersEdge,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { formFnName, perProcessFnName } from './synthetic-names.js';

/**
 * Extract nodes and edges from a single HTML / Vue / EJS / Handlebars file
 * (#170 Phases 1-4 + #173 piece A — per-form synthetic fns + submit-trigger DOM walk).
 *
 * Produces:
 *   - SourceFile node — language varies by extension (html / vue / ejs / hbs)
 *   - One synthetic FunctionDefinition per `<form>` with an `action`, named
 *     `_form_submit_L<line>`. Owns the form's MAKES_REQUEST edge.
 *   - One synthetic FunctionDefinition per inline event handler that is NOT
 *     a submit trigger of an action-bearing form, named
 *     `_<tag>_<event>_L<line>`. The schema requires every ClientSideProcess
 *     to belong to a function; this synthetic fn is the inline-handler stand-in.
 *     #173 piece B will give these fns CALLS_FUNCTION edges by parsing the
 *     attribute value (e.g., `onclick="doLogin()"`) for identifiers.
 *   - ClientSideAPICaller for every `<form action="..." method="...">`
 *   - ClientSideProcess for every inline event-handler attribute. Three
 *     binding flavors are recognized:
 *       Phase 1 (vanilla):   onclick, onsubmit, onchange, …  → framework='html-inline'
 *       Phase 2 (Angular):   (click)="...", (submit)="..."   → framework='angular-template'
 *       Phase 3 (Vue):       @click="...", v-on:click="..."  → framework='vue-template'
 *   - DEFINED_IN edge (every synthetic fn → SourceFile)
 *   - MAKES_REQUEST edge (form fn → caller)
 *   - TRIGGERS edge (ClientSideProcess → form fn or per-process fn,
 *     whichever the DOM walk says actually fires)
 *
 * Submit-trigger rule (#173 piece A): a process triggers its enclosing
 * form's fn IFF the (element, event) pair causes form submission:
 *   - `<form>` + submit | ngSubmit
 *   - `<button>` (default-type or type=submit) inside form + click
 *   - `<input type=submit | image>` inside form + click
 * All other handlers get their own per-process fn and do not appear to
 * submit any form.
 *
 * Out of scope (#173 follow-ups):
 *   - Inline JS handler resolution — `onclick="doLogin()"` does not yet
 *     emit a CALLS_FUNCTION edge to `doLogin`. Piece B.
 *   - Cross-file Angular template → component-class method resolution. Piece C.
 *   - Inline `<script>` blocks: their JS body should be dispatched through
 *     `lang-ts` for full extraction. Currently treated as opaque text.
 *   - Pug (.pug): whitespace-significant, doesn't parse with tree-sitter-html.
 *   - `<a href>` navigation — intentionally skipped (mostly noise).
 */
export function extractHtmlFile(
  tree: Tree,
  filePath: string,
  repository: string,
): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const posixPath = filePath.replace(/\\/g, '/');

  const sourceFileId = idFor.sourceFile({ repository, filePath: posixPath });
  const language = languageForExtension(posixPath);
  const sourceFile: SourceFile = {
    nodeType: 'SourceFile',
    id: sourceFileId,
    filePath: posixPath,
    repository,
    language,
    framework: null,
  };
  nodes.push(sourceFile);

  // SSG Screen emission (#198 PR3a). When a template lives at
  // `<sitedir>/<path>/index.<ext>`, emit a Screen with a derived
  // routePath. Eleventy / Hugo / Jekyll / Metalsmith / custom
  // Nunjucks builders use this index-based convention by default;
  // per-generator config overrides (front-matter `permalink:`,
  // `url:`) are an explicit follow-up. The heuristic strips a small
  // allowlist of common SSG source-tree prefixes; anything not in
  // the list keeps its directory verbatim in the routePath.
  const ssgRoute = deriveSsgScreenRoute(posixPath);
  if (ssgRoute) {
    const screen: Screen = {
      nodeType: 'Screen',
      id: idFor.screen({ repository, name: ssgRoute.name, routePath: ssgRoute.routePath }),
      name: ssgRoute.name,
      componentFunctionId: null,
      navigatorKind: 'web-router',
      routePath: ssgRoute.routePath,
      sourceFileId,
      sourceLine: 1,
      framework: 'lang-html-ssg',
      repository,
    };
    nodes.push(screen);
  }

  walkElement(tree.rootNode, {
    sourceFile,
    sourceFileId,
    repository,
    nodes,
    edges,
    formFnByElementStart: new Map(),
  });

  return { nodes, edges };
}

interface WalkCtx {
  readonly sourceFile: SourceFile;
  readonly sourceFileId: string;
  readonly repository: string;
  readonly nodes: SchemaNode[];
  readonly edges: SchemaEdge[];
  /** form element startIndex → form's synthetic fn. Set on the way down,
   *  read by descendant handlers when they look up their enclosing form. */
  readonly formFnByElementStart: Map<number, FunctionDefinition>;
}

function walkElement(node: SyntaxNode, ctx: WalkCtx): void {
  // Tree-sitter-html parses `<script>` and `<style>` as `script_element`
  // and `style_element` (with raw-text bodies), not the generic `element`.
  // Handle both shapes the same way for tag-name + attribute dispatch.
  if (node.type === 'element' || node.type === 'script_element' || node.type === 'style_element') {
    const startTag = findChild(node, 'start_tag') ?? findChild(node, 'self_closing_tag');
    if (startTag) {
      handleStartTag(startTag, node, ctx);
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    walkElement(node.child(i)!, ctx);
  }
}

function handleStartTag(startTag: SyntaxNode, element: SyntaxNode, ctx: WalkCtx): void {
  const tagName = findChild(startTag, 'tag_name')?.text.toLowerCase() ?? '';
  const attrs = collectAttributes(startTag);

  // <form action method> → ClientSideAPICaller + per-form synthetic fn.
  // The per-form fn registers itself for descendants to find.
  if (tagName === 'form') {
    emitFormCallerAndFn(startTag, element, attrs, ctx);
  }

  // <script> in a Vue or Svelte SFC → parse the JS body for method
  // definitions and emit FunctionDefinition stubs. The resolve-inline-
  // handlers pass walks each stub's evidence.snippet for cross-file
  // CALLS_FUNCTION targets (Vue/Svelte share the same regex patterns
  // for top-level `function name()` and `const name = (...) =>`).
  if (tagName === 'script' && (ctx.sourceFile.language === 'vue' || ctx.sourceFile.language === 'svelte')) {
    emitVueScriptMethods(element, ctx);
  }

  // Event-handler attributes — three binding flavors.
  for (const attr of attrs) {
    const binding = classifyEventBinding(attr.name, ctx.sourceFile.language);
    if (binding) {
      emitHandlerProcess(startTag, attr, tagName, attrs, binding, ctx);
    }
  }

  // <a href="/path"> → NAVIGATES_TO edge (#198 PR3d).
  // The edge originates from this template's SourceFile id so the
  // navigation_graph MCP tool's screenByOwnSourceFile lookup
  // (mcp-server/src/server.ts after #225) finds the source Screen.
  if (tagName === 'a') {
    emitAnchorNavigationEdge(startTag, attrs, ctx);
  }
}

interface AttrInfo {
  name: string;
  value: string | null;
  node: SyntaxNode;
}

function collectAttributes(startTag: SyntaxNode): AttrInfo[] {
  const out: AttrInfo[] = [];
  for (let i = 0; i < startTag.childCount; i++) {
    const child = startTag.child(i)!;
    if (child.type !== 'attribute') continue;
    const nameNode = findChild(child, 'attribute_name');
    if (!nameNode) continue;
    // Preserve original case — Angular (`ngSubmit`) and Vue camelCase
    // directives are case-sensitive. Vanilla `onclick` matching uses a
    // case-insensitive regex below, so HTML's case-insensitivity for
    // standard attributes still works.
    out.push({ name: nameNode.text, value: extractAttributeValue(child), node: child });
  }
  return out;
}

function extractAttributeValue(attr: SyntaxNode): string | null {
  // Two shapes from tree-sitter-html:
  //   <form action="/x">   → attribute > quoted_attribute_value > attribute_value
  //   <form action=/x>     → attribute > attribute_value      (unquoted)
  const quoted = findChild(attr, 'quoted_attribute_value');
  if (quoted) {
    const inner = findChild(quoted, 'attribute_value');
    return inner?.text ?? null;
  }
  const unquoted = findChild(attr, 'attribute_value');
  return unquoted?.text ?? null;
}

function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!;
    if (c.type === type) return c;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// <form> → per-form synthetic fn + ClientSideAPICaller
// ──────────────────────────────────────────────────────────────────────

function emitFormCallerAndFn(
  startTag: SyntaxNode,
  formElement: SyntaxNode,
  attrs: AttrInfo[],
  ctx: WalkCtx,
): void {
  // HTML attribute names are case-insensitive — match `Action`, `ACTION`, etc.
  const action = attrs.find((a) => a.name.toLowerCase() === 'action')?.value;
  // No action means the form posts to the current document. We don't emit a
  // form fn or caller; submit handlers on the form fall through to per-process
  // fns (and stay at function-only until inline-JS resolution lands in B).
  if (!action) return;

  const methodAttr = attrs.find((a) => a.name.toLowerCase() === 'method')?.value;
  const httpMethod = (methodAttr ?? 'GET').toUpperCase();
  const sourceLine = startTag.startPosition.row + 1;
  const ext = detectExternalUrl(action);

  // Per-form synthetic fn. Owns the form's MAKES_REQUEST edge.
  const fnName = formFnName(sourceLine);
  const formFn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: ctx.sourceFileId, name: fnName, sourceLine }),
    name: fnName,
    sourceFileId: ctx.sourceFileId,
    sourceLine,
    parameters: [],
    returnType: null,
    isExported: false,
    isAsync: false,
    evidence: buildEvidence(startTag, ctx.sourceFile.filePath),
  };
  ctx.nodes.push(formFn);
  ctx.edges.push({ edgeType: 'DEFINED_IN', from: formFn.id, to: ctx.sourceFileId } as DefinedInEdge);

  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFileId,
      sourceLine,
      urlLiteral: action,
    }),
    functionId: formFn.id,
    sourceFileId: ctx.sourceFileId,
    sourceLine,
    httpMethod,
    urlLiteral: action,
    egressConfidence: 'exact',
    framework: 'html-form',
    repository: ctx.repository,
    ...(ext.isExternal ? { isExternal: true, externalHost: ext.host } : {}),
    evidence: buildEvidence(startTag, ctx.sourceFile.filePath),
  };
  ctx.nodes.push(caller);
  ctx.edges.push({
    edgeType: 'MAKES_REQUEST',
    from: formFn.id,
    to: caller.id,
  } as MakesRequestEdge);

  // Register so descendants can find this form when checking submit triggers.
  ctx.formFnByElementStart.set(formElement.startIndex, formFn);
}

// ──────────────────────────────────────────────────────────────────────
// Event-binding classification + ClientSideProcess emission
// ──────────────────────────────────────────────────────────────────────

interface EventBinding {
  /** The event name without the framework prefix/wrapper (e.g., 'click'). */
  eventName: string;
  /** Which template flavor produced this binding. */
  framework: 'html-inline' | 'angular-template' | 'vue-template' | 'svelte-template';
}

/**
 * Classify an attribute name as an event-handler binding:
 *   onclick, onsubmit, …    → vanilla HTML
 *   (click), (submit), …    → Angular property binding for an event
 *   @click, v-on:click, …   → Vue directive
 *   on:click, on:submit, … → Svelte (Svelte 4 / SvelteKit) — uses
 *                            `on:event` directives, distinct from the
 *                            vanilla `onclick` syntax.
 *   :click, [foo]           → NOT events (Vue prop binding / Angular property binding)
 */
function classifyEventBinding(name: string, language?: string): EventBinding | null {
  // Svelte 4 syntax: `on:click`, `on:submit|preventDefault`, … Must
  // come BEFORE the vanilla `on…` test so we don't capture
  // `on:click` as an HTML inline `oncolon-click`.
  const svelte = /^on:([a-zA-Z][\w]*)(?:\|[\w|]+)?$/.exec(name);
  if (svelte) return { eventName: svelte[1], framework: 'svelte-template' };

  // Vanilla HTML inline handler (`onclick`, `onSubmit`, `ONCLICK`, …).
  // Case-insensitive per HTML semantics. Bare `on` is filtered.
  //
  // In a Svelte SFC, Svelte 5 syntax drops the `:` and uses plain
  // `onclick={fn}`. Indistinguishable from vanilla HTML by attribute
  // name alone — disambiguate by the file's language so the framework
  // label is accurate downstream.
  const vanilla = /^on([a-z]+)$/i.exec(name);
  if (vanilla) {
    const framework: EventBinding['framework'] =
      language === 'svelte' ? 'svelte-template' : 'html-inline';
    return { eventName: vanilla[1].toLowerCase(), framework };
  }

  // Angular: `(click)`, `(submit)`, `(ngSubmit)`, …
  const ng = /^\(([a-zA-Z][\w]*)\)$/.exec(name);
  if (ng) return { eventName: ng[1], framework: 'angular-template' };

  // Vue: `@click`, `@submit.prevent`, …
  const vueAt = /^@([a-zA-Z][\w]*)(?:\.[\w.]+)?$/.exec(name);
  if (vueAt) return { eventName: vueAt[1], framework: 'vue-template' };

  // Vue: `v-on:click`, `v-on:submit.prevent`, …
  const vueLong = /^v-on:([a-zA-Z][\w]*)(?:\.[\w.]+)?$/.exec(name);
  if (vueLong) return { eventName: vueLong[1], framework: 'vue-template' };

  return null;
}

function emitHandlerProcess(
  startTag: SyntaxNode,
  attr: AttrInfo,
  tagName: string,
  attrs: AttrInfo[],
  binding: EventBinding,
  ctx: WalkCtx,
): void {
  const sourceLine = startTag.startPosition.row + 1;
  // Encode tag + event so multiple handlers on one element stay distinct.
  // The event name is normalized — `(click)` and `onclick` both become
  // `<tag>.click` so downstream queries can match by event without caring
  // about the source dialect.
  const processName = `${tagName}.${binding.eventName}`;

  // Always emit a per-process fn — it represents the inline JS body of
  // this attribute and is the anchor for #173 piece B's CALLS_FUNCTION
  // resolution. For submit-trigger handlers we also emit a CALLS_FUNCTION
  // edge from the per-process fn to the enclosing form fn, so the flow
  // walker can chain process → per-process fn → form fn → caller.
  const perProcessFn = emitPerProcessFn(startTag, attr, tagName, binding, ctx);

  const enclosingFormFn = findEnclosingFormFn(startTag, ctx);
  const submits = enclosingFormFn !== null
    && elementAndEventCausesSubmit(tagName, binding.eventName, attrs);
  if (submits) {
    ctx.edges.push({
      edgeType: 'CALLS_FUNCTION',
      from: perProcessFn.id,
      to: enclosingFormFn!.id,
      sourceLine,
      arguments: [],
      isConditional: false,
      confidence: 'direct',
    } as CallsFunctionEdge);
  }

  const proc: ClientSideProcess = {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({
      sourceFileId: ctx.sourceFileId,
      sourceLine,
      // Include the raw attribute in the id key so a vanilla `onclick`
      // and an Angular `(click)` on the same line don't collide.
      name: `${processName}#${attr.name}`,
    }),
    kind: 'event_handler',
    name: processName,
    functionId: perProcessFn.id,
    sourceFileId: ctx.sourceFileId,
    sourceLine,
    framework: binding.framework,
    repository: ctx.repository,
    // Evidence points at the attribute itself (e.g., `onclick="..."`)
    // rather than the entire start tag, so MCP queries surface the
    // specific binding that matched.
    evidence: buildEvidence(attr.node, ctx.sourceFile.filePath),
  };
  ctx.nodes.push(proc);
  ctx.edges.push({
    edgeType: 'TRIGGERS',
    from: proc.id,
    to: perProcessFn.id,
  } as TriggersEdge);
}

function emitPerProcessFn(
  startTag: SyntaxNode,
  attr: AttrInfo,
  tagName: string,
  binding: EventBinding,
  ctx: WalkCtx,
): FunctionDefinition {
  const sourceLine = startTag.startPosition.row + 1;
  // attr.name is included in the key so a vanilla `onclick` and an Angular
  // `(click)` on the same line and tag yield distinct ids.
  const fnName = perProcessFnName(tagName, binding.eventName, sourceLine, attr.name);
  const fn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: ctx.sourceFileId, name: fnName, sourceLine }),
    name: fnName,
    sourceFileId: ctx.sourceFileId,
    sourceLine,
    parameters: [],
    returnType: null,
    isExported: false,
    isAsync: false,
    evidence: buildEvidence(attr.node, ctx.sourceFile.filePath),
  };
  ctx.nodes.push(fn);
  ctx.edges.push({ edgeType: 'DEFINED_IN', from: fn.id, to: ctx.sourceFileId } as DefinedInEdge);
  return fn;
}

// ──────────────────────────────────────────────────────────────────────
// `<a href>` → NAVIGATES_TO edge (#198 PR3d)
// ──────────────────────────────────────────────────────────────────────

/**
 * When a template contains `<a href="/path">`, emit a NAVIGATES_TO
 * edge from the template's SourceFile id to the target Screen id
 * (computed via `idFor.screen` using the resolved routePath).
 *
 * The target Screen's id is the SAME shape as #198 PR3a's emission:
 *   `idFor.screen({ repository, name: routePath, routePath })`
 *
 * The target Screen may or may not exist in the graph (depends on
 * whether the destination file emitted a Screen) — the edge is
 * emitted unconditionally per #198's design ("Resolves whether or
 * not the target Screen is also captured.").
 *
 * Conservative filters — emit only for clearly-internal links:
 *   - href must start with `/` (absolute path within the site).
 *   - href must NOT contain `://` (external URL).
 *   - href must NOT start with `//` (protocol-relative external).
 *   - href must NOT contain `{{` or `{%` (unresolved template tag).
 *   - href must NOT start with `#`, `mailto:`, `tel:`, `javascript:`.
 *
 * Path normalization for the target routePath:
 *   - Strip query string (`?...`) and fragment (`#...`).
 *   - Strip a trailing `/index.<ext>` (the same SSG extensions that
 *     produce Screens in PR3a).
 *   - Ensure trailing `/`.
 *   - Special-case: empty path → `/`.
 */
function emitAnchorNavigationEdge(
  startTag: SyntaxNode,
  attrs: AttrInfo[],
  ctx: WalkCtx,
): void {
  const hrefAttr = attrs.find((a) => a.name.toLowerCase() === 'href');
  if (!hrefAttr || !hrefAttr.value) return;
  const targetRoute = resolveAnchorHref(hrefAttr.value);
  if (targetRoute === null) return;

  const targetId = idFor.screen({
    repository: ctx.repository,
    name: targetRoute,
    routePath: targetRoute,
  });

  ctx.edges.push({
    edgeType: 'NAVIGATES_TO',
    from: ctx.sourceFileId,
    to: targetId,
    method: 'href',
    sourceLine: startTag.startPosition.row + 1,
  } as NavigatesToEdge);
}

/**
 * Normalize an href attribute value to a routePath, or return null
 * when the href is unresolvable (external, dynamic, fragment, etc.).
 */
export function resolveAnchorHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '') return null;
  // External / protocol-relative.
  if (trimmed.startsWith('//') || trimmed.includes('://')) return null;
  // Anchor / mailto / tel / javascript / data URIs.
  if (trimmed.startsWith('#')) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mailto:') || lower.startsWith('tel:') || lower.startsWith('javascript:') || lower.startsWith('data:')) {
    return null;
  }
  // Unresolved template tags — `{{ url }}`, `{% url 'name' %}`,
  // `{$var}`, etc. Skip; we'd need template-engine awareness to
  // resolve them.
  if (trimmed.includes('{{') || trimmed.includes('{%')) return null;
  // Must be an absolute internal path. Relative paths require knowing
  // the current page's routePath to resolve, which is out of scope
  // for the conservative first pass.
  if (!trimmed.startsWith('/')) return null;

  // Strip query string and fragment.
  let path = trimmed;
  const queryIdx = path.indexOf('?');
  if (queryIdx >= 0) path = path.slice(0, queryIdx);
  const hashIdx = path.indexOf('#');
  if (hashIdx >= 0) path = path.slice(0, hashIdx);

  // Strip a trailing `/index.<ext>` so `/about/index.html` and
  // `/about/` produce the same target id (matches PR3a's emit shape).
  const indexMatch = path.match(/\/index\.([^/.]+)$/i);
  if (indexMatch && SSG_SCREEN_EXTENSIONS.has(indexMatch[1].toLowerCase())) {
    path = path.slice(0, -indexMatch[0].length + 1); // keep the trailing slash
  }

  // Normalize: ensure trailing `/` for non-root paths, but `/` itself stays `/`.
  if (path === '') path = '/';
  if (!path.endsWith('/')) path = path + '/';

  return path;
}

// ──────────────────────────────────────────────────────────────────────
// Vue <script> method extraction (#173 piece C)
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse the JS body of a Vue SFC `<script>` block and emit FunctionDefinition
 * stubs for methods. These are anchors for resolveInlineHandlers — the
 * template's `@click="onSubmit"` matches by name to the stub, and a future
 * lang-ts-driven extractor can fill in the call bodies.
 *
 * Recognized patterns (regex — same conservatism as piece B):
 *   - Options API method shorthand inside `methods: { ... }`:
 *       `onSubmit() { ... }`
 *   - Top-level function declarations (Vue 3 `<script setup>`):
 *       `function onSubmit() { ... }`
 *   - Top-level arrow / function-bound consts:
 *       `const onSubmit = () => { ... }`
 *       `const onSubmit = function() { ... }`
 */
function emitVueScriptMethods(scriptElement: SyntaxNode, ctx: WalkCtx): void {
  // Tree-sitter-html parses script_element children as start_tag + raw_text +
  // end_tag. Grab raw_text directly so we don't have to strip the wrapper
  // ourselves (handles `<script lang="ts">`, `<script setup>`, etc.).
  const rawText = findChild(scriptElement, 'raw_text');
  if (!rawText) return;
  const inner = rawText.text;
  const lineOffset = rawText.startPosition.row;

  const seen = new Set<string>();
  for (const { name, line, endLine, body } of harvestVueMethodNames(inner, lineOffset)) {
    if (seen.has(name)) continue;
    seen.add(name);
    // When a brace-balanced body was located, stash it on evidence.snippet
    // so the post-pass resolver can scan it for cross-file CALLS_FUNCTION
    // targets — same algorithm as inline-handler resolution, but the
    // snippet is the method body rather than an attribute value.
    const fn: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId: ctx.sourceFileId, name, sourceLine: line }),
      name,
      sourceFileId: ctx.sourceFileId,
      sourceLine: line,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
      ...(body !== null
        ? {
            evidence: {
              filePath: ctx.sourceFile.filePath,
              lineStart: line,
              lineEnd: endLine,
              snippet: body,
              confidence: 'heuristic' as const,
            },
          }
        : {}),
    };
    ctx.nodes.push(fn);
    ctx.edges.push({ edgeType: 'DEFINED_IN', from: fn.id, to: ctx.sourceFileId } as DefinedInEdge);
  }
}

interface VueMethod {
  name: string;
  /** 1-based line number where the method header starts. */
  line: number;
  /** 1-based line number where the body ends (or `line` if no body found). */
  endLine: number;
  /**
   * Brace-balanced body content (without the surrounding braces) for
   * patterns 1 and 2, or the right-hand expression for pattern 3.
   * `null` when we can't locate a body — the FunctionDefinition stub
   * is still emitted, but the resolver can't follow its calls.
   */
  body: string | null;
}

/**
 * Names that the SHORTHAND regex would otherwise capture but aren't
 * methods we want to expose as FunctionDefinition stubs:
 *   - JS keywords that can syntactically precede a `(` (`if`, `function`, …).
 *   - Vue Options API top-level keys (`data`, `computed`, `methods`, …) —
 *     they appear as `key() {` shorthand but are containers, not methods.
 *   - Vue 2/3 lifecycle hooks (`mounted`, `created`, …) — emitting stubs
 *     for these adds noise to MCP queries since templates rarely reference
 *     them by name. If a real-world fixture proves any of these IS used as
 *     a handler, drop it from this set.
 */
const VUE_KEYWORDS = new Set([
  // JS reserved / contextual keywords
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return',
  'void', 'typeof', 'instanceof', 'new', 'delete', 'in', 'of',
  'function', 'var', 'let', 'const', 'try', 'catch', 'finally',
  'throw', 'async', 'await', 'yield', 'class', 'true', 'false',
  'null', 'undefined', 'this', 'super', 'export', 'import', 'default',
  'from', 'as', 'static', 'public', 'private', 'protected', 'abstract',
  'readonly', 'interface', 'type', 'namespace', 'module', 'enum',
  // Vue Options API top-level option keys
  'data', 'computed', 'methods', 'watch', 'props', 'components',
  'directives', 'mixins', 'inject', 'provide', 'name', 'template',
  'render', 'emits', 'expose', 'inheritAttrs', 'setup', 'model',
  // Vue 2 lifecycle hooks
  'beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate',
  'updated', 'beforeDestroy', 'destroyed', 'activated', 'deactivated',
  'errorCaptured',
  // Vue 3 lifecycle hooks (additions)
  'beforeUnmount', 'unmounted', 'renderTracked', 'renderTriggered',
  'serverPrefetch',
]);

function harvestVueMethodNames(body: string, lineOffset: number): VueMethod[] {
  const out: VueMethod[] = [];
  const lineOf = (offset: number): number =>
    lineOffset + 1 + body.slice(0, offset).split('\n').length - 1;

  // Pattern 1: Options API method shorthand → `name(...) {`. Captures bare
  // identifiers followed by `(` then `)` (with optional args) then `{`.
  // Negative lookbehind on `.` skips `obj.method()` calls.
  const SHORTHAND = /(?<![.\w$])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = SHORTHAND.exec(body)) !== null) {
    const name = m[1];
    if (VUE_KEYWORDS.has(name)) continue;
    const headerEnd = m.index + m[0].length - 1;
    const { body: bodyText, endOffset } = sliceBracedBody(body, headerEnd);
    out.push({
      name,
      line: lineOf(m.index),
      endLine: lineOf(endOffset ?? m.index + m[0].length),
      body: bodyText,
    });
  }

  // Pattern 2: top-level `function name() { ... }` declarations.
  const FN_DECL = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = FN_DECL.exec(body)) !== null) {
    // For function declarations, skip past the parameter list to find the `{`.
    const openBrace = findOpenBraceAfterParams(body, m.index + m[0].length - 1);
    if (openBrace < 0) {
      out.push({ name: m[1], line: lineOf(m.index), endLine: lineOf(m.index), body: null });
      continue;
    }
    const { body: bodyText, endOffset } = sliceBracedBody(body, openBrace);
    out.push({
      name: m[1],
      line: lineOf(m.index),
      endLine: lineOf(endOffset ?? openBrace),
      body: bodyText,
    });
  }

  // Pattern 3: `const name = (args) => …` or `const name = function(...)`.
  // Two shapes share the regex; the trailing capture is `(` (arrow) or
  // `function` (function expression). We branch on which one fired so the
  // body-finder doesn't get confused by:
  //   - object defaults in the param list (`(a = { x: 1 }) => doStuff()`)
  //     which would otherwise look like a function body brace to a naive
  //     `indexOf('{')` scan.
  //   - TS return-type literals (`(): { x: number } => …`) which would
  //     otherwise look like an arrow block body.
  const CONST_FN = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(\(|function)/g;
  while ((m = CONST_FN.exec(body)) !== null) {
    const lead = m[2]!;
    const tail = m.index + m[0].length;
    let bodyText: string | null = null;
    let endOffset: number | null = null;

    if (lead === '(') {
      // Arrow function. The `(` is at `tail - 1`. Skip the balanced param
      // list (respecting strings and nested parens for default-value
      // expressions and inline function types), then optionally skip a
      // TS return-type annotation, then expect `=>`.
      const paramOpenIdx = tail - 1;
      const closeParenIdx = matchBalancedParen(body, paramOpenIdx);
      if (closeParenIdx >= 0) {
        let j = skipWhitespace(body, closeParenIdx + 1);
        if (body[j] === ':') {
          // Return-type annotation: skip until we land on the `=>` that
          // separates type from body.
          j = findArrowAfterType(body, j + 1);
        }
        if (j >= 0 && body[j] === '=' && body[j + 1] === '>') {
          const afterArrow = skipWhitespace(body, j + 2);
          if (body[afterArrow] === '{') {
            const sliced = sliceBracedBody(body, afterArrow);
            bodyText = sliced.body;
            endOffset = sliced.endOffset;
          } else {
            const exprEnd = findExprBodyEnd(body, afterArrow);
            bodyText = body.slice(afterArrow, exprEnd);
            endOffset = exprEnd;
          }
        }
      }
    } else {
      // Function expression: `const name = function [optional-name] (args) [: ReturnType] { … }`
      const parenIdx = body.indexOf('(', tail);
      if (parenIdx >= 0) {
        const openBrace = findOpenBraceAfterParams(body, parenIdx);
        if (openBrace >= 0) {
          const sliced = sliceBracedBody(body, openBrace);
          bodyText = sliced.body;
          endOffset = sliced.endOffset;
        }
      }
    }

    out.push({
      name: m[1],
      line: lineOf(m.index),
      endLine: lineOf(endOffset ?? m.index),
      body: bodyText,
    });
  }

  return out;
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  return i;
}

/**
 * From the offset of an opening `{`, return the substring between the
 * brace and its matching `}` plus the offset of that `}`. Returns null
 * body when the brace is unbalanced — the caller emits a stub without
 * evidence in that case. Skips contents of `//` line comments, `/star … star/`
 * block comments, and `'…'` / `"…"` / `` `…` `` string literals so braces
 * inside those don't throw off the depth counter.
 */
function sliceBracedBody(
  text: string,
  openBraceIdx: number,
): { body: string | null; endOffset: number | null } {
  const closeIdx = matchClosingBrace(text, openBraceIdx);
  if (closeIdx < 0) return { body: null, endOffset: null };
  return { body: text.slice(openBraceIdx + 1, closeIdx), endOffset: closeIdx };
}

/**
 * Heuristic: is the `/` at `slashIdx` the start of a regex literal, or
 * a division operator? In JS, `/` is division when it follows a value
 * (identifier, `)`, `]`, number) and starts a regex literal otherwise.
 * Walks back through whitespace and the preceding token. Conservative —
 * unknown contexts default to "regex" so we always skip past it as a
 * unit rather than letting a stray `}` in `/^\}/` cascade into the
 * outer brace counter.
 */
function isRegexContext(text: string, slashIdx: number): boolean {
  let i = slashIdx - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i--; continue; }
    if (ch === ')' || ch === ']') return false;
    if (/[\w$]/.test(ch)) {
      // Read the whole identifier and decide based on keyword class.
      let j = i;
      while (j >= 0 && /[\w$]/.test(text[j]!)) j--;
      const ident = text.slice(j + 1, i + 1);
      // Keywords that introduce an expression — `/` after them is regex.
      return REGEX_LEADING_KEYWORDS.has(ident);
    }
    // Operators, `{`, `}`, `;`, `,`, `(`, etc. all start an expression
    // context. `/` after them is a regex.
    return true;
  }
  return true;
}

const REGEX_LEADING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete',
  'throw', 'new', 'do', 'yield', 'await', 'case',
]);

/**
 * From the offset of `/` known to start a regex literal, return the
 * offset just past the closing `/<flags>`. Skips `\\` escapes and
 * `[...]` character classes (where `/` is NOT a regex terminator).
 * If the regex looks unterminated (unescaped newline outside a
 * character class), returns just past the opening slash so the outer
 * scan continues.
 */
function scanPastRegexLiteral(text: string, startIdx: number): number {
  let i = startIdx + 1;
  let inCharClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[' && !inCharClass) { inCharClass = true; i++; continue; }
    if (ch === ']' && inCharClass) { inCharClass = false; i++; continue; }
    if (ch === '/' && !inCharClass) {
      i++;
      while (i < text.length && /[a-z]/i.test(text[i]!)) i++;
      return i;
    }
    if (ch === '\n' && !inCharClass) return startIdx + 1;
    i++;
  }
  return text.length;
}

function scanPastJsString(text: string, startIdx: number): number {
  const quote = text[startIdx];
  let i = startIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    // For template literals, `${ … }` would need brace tracking; we
    // intentionally don't recurse — the worst case is the resolver
    // attributing a call to the wrong outer method when an interpolation
    // contains `}` followed by an identifier-call pattern. Acceptable
    // for a regex-based pass; the ts-morph upgrade path covers it precisely.
    i++;
  }
  return text.length;
}

/**
 * From the offset of `{`, return the offset of the matching `}` or -1
 * if unbalanced. Skips `//` and `/star … star/` comments and `'…'` /
 * `"…"` / `` `…` `` strings so braces inside those don't throw off the
 * depth counter. Shared by `sliceBracedBody` and the return-type
 * probe in `findOpenBraceAfterParams`.
 */
function matchClosingBrace(text: string, openBraceIdx: number): number {
  if (text[openBraceIdx] !== '{') return -1;
  let depth = 1;
  let i = openBraceIdx + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = scanPastJsString(text, i);
      continue;
    }
    if (ch === '/' && isRegexContext(text, i)) {
      i = scanPastRegexLiteral(text, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

/**
 * From the offset of `(`, return the offset of the matching `)` or
 * -1 if unbalanced. Skips strings so a `)` inside a string literal
 * default value doesn't close the param list early.
 */
function matchBalancedParen(text: string, openParenIdx: number): number {
  if (text[openParenIdx] !== '(') return -1;
  let depth = 1;
  let i = openParenIdx + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = scanPastJsString(text, i);
      continue;
    }
    if (ch === '/' && isRegexContext(text, i)) {
      i = scanPastRegexLiteral(text, i);
      continue;
    }
    if (ch === '{') {
      const close = matchClosingBrace(text, i);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

/**
 * Walk forward from a TS return-type prefix (just past the `:`) to the
 * `=>` that separates type from arrow body. Skips balanced `{…}`,
 * `[…]`, `(…)` groups (so `: Promise<{ x: number }> =>` works), and
 * string/template-literal types. Returns the offset of the `=` of `=>`,
 * or -1 if no arrow is found before reasonable bounds.
 */
function findArrowAfterType(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = scanPastJsString(text, i); continue; }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    // Regex literals don't appear inside type expressions, but adding
    // the skip here keeps the helper safe if future use-sites call it
    // from a non-type context.
    if (ch === '/' && isRegexContext(text, i)) {
      i = scanPastRegexLiteral(text, i);
      continue;
    }
    if (ch === '{') {
      const close = matchClosingBrace(text, i);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (ch === '(') {
      // A `(…)` inside a type expression is a function-type signature
      // — skip past it as a unit.
      const close = matchBalancedParen(text, i);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (ch === '=' && text[i + 1] === '>') return i;
    // Hard terminator: a semicolon at top level means the declaration
    // ended without an arrow (so this CONST_FN wasn't actually an arrow
    // function — could be a typed function-type binding without body).
    if (ch === ';') return -1;
    i++;
  }
  return -1;
}

/**
 * Skip past a parenthesized parameter list and an optional TS return-type
 * annotation to the opening `{` of a function body. `start` is the
 * position of the `(`.
 *
 * Handles object literals in defaults (`(a = { x: 1 })`) by skipping
 * balanced groups inside the params, and TS return-type literals
 * (`function foo(): { name: string } { … }`) by probing: when the first
 * `{` after `)` is immediately followed (modulo whitespace) by another
 * `{`, the first was a type literal and the second is the body.
 *
 * Known limitation: complex return-type expressions involving unions of
 * object literals followed by other type tokens (`(): { x: number } | string { … }`)
 * may still mis-resolve because the probe only looks for an immediate-
 * following body brace, not for arbitrary type-continuation tokens.
 * Acceptable for a regex pass; documented for the ts-morph upgrade.
 */
function findOpenBraceAfterParams(text: string, paramOpenIdx: number): number {
  const closeParenIdx = matchBalancedParen(text, paramOpenIdx);
  if (closeParenIdx < 0) return -1;
  let i = skipWhitespace(text, closeParenIdx + 1);
  // Optional return-type annotation: `: <Type>` then body brace.
  if (text[i] === ':') {
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'" || ch === '`') { i = scanPastJsString(text, i); continue; }
      if (ch === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl + 1; continue; }
      if (ch === '/' && text[i + 1] === '*') { const close = text.indexOf('*/', i + 2); i = close < 0 ? text.length : close + 2; continue; }
      if (ch === '{') {
        // Probe: type literal or body? If immediately followed by another
        // `{` (modulo whitespace), this was a type literal.
        const closeIdx = matchClosingBrace(text, i);
        if (closeIdx < 0) return -1;
        const probe = skipWhitespace(text, closeIdx + 1);
        if (text[probe] === '{') return probe;
        return i;
      }
      i++;
    }
    return -1;
  }
  return text[i] === '{' ? i : -1;
}

function findExprBodyEnd(text: string, start: number): number {
  // Stop at the next semicolon at top level (depth 0). Treat `,` at
  // depth 0 as a terminator too — `const a = () => x, b = …` is
  // legal but rare; bounding the slice is the goal, not perfect parsing.
  //
  // `\n` only terminates AFTER a non-whitespace character has been seen
  // on this expression: multi-line arrow bodies like
  //   const foo = () =>
  //     bar(x).then(baz);
  // start with `=>\n  bar(x)...` — the leading newline is just the
  // line break between `=>` and the body, not a statement boundary.
  //
  // Strings, comments, and regex literals are skipped as opaque units
  // — without that, an arrow body like `() => "x;y"` or `() => // note\n  foo()`
  // would terminate at the embedded `;` or end-of-line-comment and lose
  // the real call site.
  let depth = 0;
  let sawNonWs = false;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      // Line comment — skip; do NOT count as "saw non-whitespace" so a
      // multi-line arrow with a leading comment still finds its body.
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = scanPastJsString(text, i);
      sawNonWs = true;
      continue;
    }
    if (ch === '/' && isRegexContext(text, i)) {
      i = scanPastRegexLiteral(text, i);
      sawNonWs = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      sawNonWs = true;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;
      depth--;
      sawNonWs = true;
    } else if (depth === 0 && (ch === ';' || ch === ',')) {
      return i;
    } else if (depth === 0 && ch === '\n' && sawNonWs) {
      return i;
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      sawNonWs = true;
    }
    i++;
  }
  return i;
}

// ──────────────────────────────────────────────────────────────────────
// Submit-trigger DOM walk (#173 piece A)
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk up from a start_tag to find the registered form fn for the nearest
 * enclosing `<form>` element. Returns null if not inside any form (or if
 * the form has no `action` and so wasn't registered).
 */
function findEnclosingFormFn(startTag: SyntaxNode, ctx: WalkCtx): FunctionDefinition | null {
  // start_tag.parent is the element node itself. From there walk up through
  // ancestor elements looking for one we registered as a form.
  let current: SyntaxNode | null = startTag.parent;
  while (current) {
    if (current.type === 'element') {
      const fn = ctx.formFnByElementStart.get(current.startIndex);
      if (fn) return fn;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Decide whether (element, event) actually submits a form. Mirrors HTML
 * default behavior:
 *   - <form> + submit | ngSubmit  → form's own submit event
 *   - <button> (default-type or type=submit) + click in a form → submits
 *   - <input type=submit | image> + click in a form           → submits
 *   - everything else                                         → does not submit
 */
function elementAndEventCausesSubmit(
  tagName: string,
  eventName: string,
  attrs: AttrInfo[],
): boolean {
  // Form's own submit event. ngSubmit is Angular's intercepted form-submit.
  // Vue's @submit and vanilla onsubmit both normalize to 'submit'.
  if (tagName === 'form') {
    return eventName === 'submit' || eventName === 'ngSubmit';
  }

  // Click on a submit-triggering input/button. Other events (mouseover,
  // focus, change, …) never submit, regardless of element.
  if (eventName !== 'click') return false;

  const type = attrs.find((a) => a.name.toLowerCase() === 'type')?.value?.toLowerCase();

  if (tagName === 'button') {
    // Per HTML spec, <button> default type is 'submit'. Only 'reset' and
    // 'button' opt out. An unknown / mistyped value falls back to submit.
    return type !== 'reset' && type !== 'button';
  }

  if (tagName === 'input') {
    return type === 'submit' || type === 'image';
  }

  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Per-extension language tag (#170 Phases 3-4)
// ──────────────────────────────────────────────────────────────────────

/**
 * SourceFile.language reflects the language of the file content, not the
 * plugin id. A `.vue` SFC is parsed by lang-html (since the body is
 * HTML-shaped) but it isn't HTML — it's Vue. Surfacing that distinction
 * lets MCP queries filter (e.g., "find all Vue templates").
 */
function languageForExtension(posixPath: string): string {
  const lower = posixPath.toLowerCase();
  if (lower.endsWith('.vue')) return 'vue';
  if (lower.endsWith('.svelte')) return 'svelte';
  if (lower.endsWith('.ejs')) return 'ejs';
  if (lower.endsWith('.hbs') || lower.endsWith('.handlebars')) return 'handlebars';
  if (lower.endsWith('.njk')) return 'nunjucks';
  if (lower.endsWith('.j2') || lower.endsWith('.jinja') || lower.endsWith('.jinja2')) {
    return 'jinja';
  }
  if (lower.endsWith('.twig')) return 'twig';
  if (lower.endsWith('.liquid')) return 'liquid';
  if (lower.endsWith('.mustache')) return 'mustache';
  return 'html';
}

// ──────────────────────────────────────────────────────────────────────
// SSG Screen route derivation (#198 PR3a)
// ──────────────────────────────────────────────────────────────────────

/**
 * Extensions whose `index.<ext>` siblings should produce SSG Screen
 * nodes. `.vue` is intentionally NOT here — Vue SFCs are SPA components
 * routed by react-router-dom / Vue Router, not by index-based file
 * routing.
 */
const SSG_SCREEN_EXTENSIONS: ReadonlySet<string> = new Set([
  'html', 'htm', 'njk', 'ejs', 'hbs', 'handlebars',
  'j2', 'jinja', 'jinja2', 'twig', 'liquid', 'mustache',
]);

/**
 * Common SSG source-tree prefixes to strip when computing routePath.
 * Listed longest-first so iterative front-stripping converges quickly.
 * Conservative — anything not in this list keeps its directory verbatim
 * in the resulting routePath. The user can apply stitch rules later if
 * they need finer control.
 */
/**
 * Path segments that mark a tree as vendored or build-generated.
 * An `index.html` inside any of these is never a real route — they
 * are dependency snapshots (node_modules), build artifacts (dist,
 * build, out, .next, .nuxt, .svelte-kit, .output), or coverage /
 * cache reports. Matched by `startsWith` or `/<seg>` to handle both
 * top-level and nested occurrences.
 *
 * Lowercased; lowercase comparison.
 */
const VENDOR_PATH_SEGMENTS: ReadonlyArray<string> = [
  'node_modules/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.output/',
  '.cache/',
  'coverage/',
  'storybook-static/',
];

const SSG_SOURCE_PREFIXES: ReadonlyArray<string> = [
  'static-site-template/',
  'static-site/',
  'site-files-src/',
  'site-files/',
  'src/pages/',
  'src/views/',
  'src/templates/',
  'pages/',
  'views/',
  'templates/',
  '_site/',
  'site/',
  'public/',
  'static/',
  'dist/',
  'build/',
  'src/',
];

interface SsgScreenRoute {
  routePath: string;
  name: string;
}

/**
 * Decide whether `posixPath` is an SSG `index.<ext>` template that
 * should produce a Screen. Returns `null` when the filename isn't an
 * `index.<ext>` of a recognized SSG extension.
 *
 * The routePath strips common SSG source-tree prefixes (`pages/`,
 * `views/`, `static-site/`, etc.) iteratively from the front, then
 * removes the trailing `/index.<ext>`. Empty result → `/`.
 *
 * Examples (assuming the file lives at the cited path):
 *   site-files-src/blog/post-1/index.njk → /blog/post-1/   name = '/blog/post-1/'
 *   pages/about/index.html               → /about/        name = '/about/'
 *   index.njk                            → /              name = '/'
 *   path/we/dont/recognize/index.njk     → /path/we/dont/recognize/
 */
export function deriveSsgScreenRoute(posixPath: string): SsgScreenRoute | null {
  const lower = posixPath.toLowerCase();

  // Vendor / build-output filter (#198 PR3a follow-up). An `index.html`
  // copied into `node_modules/`, `dist/`, `.next/`, etc. should NOT
  // produce a Screen — those are dependency snapshots or generated
  // artifacts, not real routes. The caller (extract-source-file) does
  // file-level work before this function runs, so guarding here keeps
  // the rule local to the SSG inference logic.
  for (const seg of VENDOR_PATH_SEGMENTS) {
    if (lower.startsWith(seg) || lower.includes(`/${seg}`)) return null;
  }

  // Filename must be `index.<ext>` for one of the recognized extensions.
  const slashIdx = lower.lastIndexOf('/');
  const filename = slashIdx >= 0 ? lower.slice(slashIdx + 1) : lower;
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const stem = filename.slice(0, dotIdx);
  const ext = filename.slice(dotIdx + 1);
  if (stem !== 'index') return null;
  if (!SSG_SCREEN_EXTENSIONS.has(ext)) return null;

  // Strip the trailing `index.<ext>`.
  let dirPath = slashIdx >= 0 ? posixPath.slice(0, slashIdx + 1) : '';

  // Iteratively strip recognized SSG source-tree prefixes from the front.
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of SSG_SOURCE_PREFIXES) {
      if (dirPath.startsWith(prefix)) {
        dirPath = dirPath.slice(prefix.length);
        changed = true;
        break;
      }
    }
  }

  // Normalize: ensure leading `/`. Trailing `/` is preserved (the
  // dirPath always ends with `/` because we kept the slash after
  // stripping `index.<ext>`).
  let routePath = dirPath.startsWith('/') ? dirPath : '/' + dirPath;
  if (routePath === '') routePath = '/';

  return { routePath, name: routePath };
}

// ──────────────────────────────────────────────────────────────────────
// Source evidence (mirrors lang-ts/src/evidence.ts for tree-sitter nodes)
// ──────────────────────────────────────────────────────────────────────

const MAX_SNIPPET_LENGTH = 500;

function buildEvidence(node: SyntaxNode, filePath: string): {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  confidence: 'exact' | 'heuristic' | 'inferred';
} {
  const text = node.text;
  return {
    filePath,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    snippet: text.length > MAX_SNIPPET_LENGTH ? text.slice(0, MAX_SNIPPET_LENGTH - 1) + '…' : text,
    confidence: 'exact',
  };
}

// ──────────────────────────────────────────────────────────────────────
// URL classification (inlined from lang-ts/src/resolve-constant.ts to
// avoid taking a runtime dependency on the TS plugin for one helper.
// Keep in sync with `detectExternalUrl` there.)
// ──────────────────────────────────────────────────────────────────────

function detectExternalUrl(url: string): { isExternal: boolean; host: string | null } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) {
      return { isExternal: false, host: null };
    }
    if (!host.includes('.')) return { isExternal: false, host: null };
    if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.') || host.startsWith('169.254.')) {
      return { isExternal: false, host: null };
    }
    return { isExternal: true, host };
  } catch {
    return { isExternal: false, host: null };
  }
}
