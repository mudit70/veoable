import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type SourceFile,
  type FunctionDefinition,
  type ClientSideAPICaller,
  type ClientSideProcess,
  type Screen,
  type SchemaEdge,
} from '@adorable/schema';
import { type NodeBatch } from '@adorable/plugin-api';
import { HtmlLanguagePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/html/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new HtmlLanguagePlugin();
  const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });
  return plugin.extractFile(handle, file);
}

function sourceFiles(b: NodeBatch): SourceFile[] {
  return b.nodes.filter((n): n is SourceFile => n.nodeType === 'SourceFile');
}
function functions(b: NodeBatch): FunctionDefinition[] {
  return b.nodes.filter((n): n is FunctionDefinition => n.nodeType === 'FunctionDefinition');
}
function callers(b: NodeBatch): ClientSideAPICaller[] {
  return b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');
}
function processes(b: NodeBatch): ClientSideProcess[] {
  return b.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}
function screens(b: NodeBatch): Screen[] {
  return b.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
}
function edgesOfType(b: NodeBatch, t: string): SchemaEdge[] {
  return b.edges.filter((e) => e.edgeType === t);
}

/**
 * True if any flow from `processName` walks to a caller hitting `urlSubstring`,
 * via TRIGGERS → (optional CALLS_FUNCTION hops, breadth-first) → MAKES_REQUEST.
 * Models how the real flow walker chains process → per-process fn → form fn → caller.
 */
function processReachesUrl(batch: NodeBatch, processName: string, urlSubstring: string): boolean {
  const proc = processes(batch).find((p) => p.name === processName);
  if (!proc) return false;
  const seen = new Set<string>();
  const queue: string[] = edgesOfType(batch, 'TRIGGERS')
    .filter((e) => e.from === proc.id)
    .map((e) => e.to);
  while (queue.length > 0) {
    const fnId = queue.shift()!;
    if (seen.has(fnId)) continue;
    seen.add(fnId);
    for (const m of edgesOfType(batch, 'MAKES_REQUEST').filter((e) => e.from === fnId)) {
      const c = callers(batch).find((c) => c.id === m.to);
      if (c?.urlLiteral?.includes(urlSubstring)) return true;
    }
    for (const c of edgesOfType(batch, 'CALLS_FUNCTION').filter((e) => e.from === fnId)) {
      queue.push(c.to);
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// SourceFile + synthetic functions (#173 piece A)
// ──────────────────────────────────────────────────────────────────────

describe('SourceFile and synthetic function emission', () => {
  it('emits exactly one SourceFile with language="html"', async () => {
    const batch = await extract('index.html');
    const sfs = sourceFiles(batch);
    expect(sfs).toHaveLength(1);
    expect(sfs[0].language).toBe('html');
    expect(sfs[0].framework).toBeNull();
  });

  it('emits per-form synthetic fns named _form_submit_L<line> with DEFINED_IN edges', async () => {
    const batch = await extract('index.html');
    const formFns = functions(batch).filter((f) => f.name.startsWith('_form_submit_'));
    // index.html has 2 forms with action → 2 per-form fns
    expect(formFns).toHaveLength(2);

    const definedIn = edgesOfType(batch, 'DEFINED_IN');
    for (const fn of formFns) {
      const e = definedIn.find((d) => d.from === fn.id);
      expect(e).toBeDefined();
      expect(e!.to).toBe(sourceFiles(batch)[0].id);
    }
  });

  it('emits one per-handler synthetic fn for every event-handler attribute', async () => {
    const batch = await extract('index.html');
    const handlerFns = functions(batch).filter((f) => !f.name.startsWith('_form_submit_'));
    // index.html handlers: Sign-in onclick, search input onchange, Help onclick,
    // Help onmouseover. 4 per-process fns total (submit triggers also get one
    // so #173 piece B can attach CALLS_FUNCTION edges to inline JS).
    expect(handlerFns.length).toBe(4);
    expect(handlerFns.every((f) => f.name.startsWith('_'))).toBe(true);
  });

  it('passes schema validation for every emitted node', async () => {
    const batch = await extract('index.html');
    for (const node of batch.nodes) {
      expect(() => validateNode(node)).not.toThrow();
    }
  });

  it('emits no synthetic fns for a static file with no forms or handlers', async () => {
    const batch = await extract('empty.html');
    expect(sourceFiles(batch)).toHaveLength(1);
    // No forms, no handlers, no fns at all.
    expect(functions(batch)).toHaveLength(0);
    expect(callers(batch)).toHaveLength(0);
    expect(processes(batch)).toHaveLength(0);
  });

  it('attaches evidence to callers and processes (filePath, line range, snippet)', async () => {
    const batch = await extract('index.html');

    const login = callers(batch).find((c) => c.urlLiteral === '/api/login')!;
    expect(login.evidence).toBeDefined();
    expect(login.evidence!.filePath).toBe('index.html');
    expect(login.evidence!.lineStart).toBeGreaterThan(0);
    expect(login.evidence!.lineEnd).toBeGreaterThanOrEqual(login.evidence!.lineStart);
    expect(login.evidence!.snippet).toContain('action="/api/login"');
    expect(login.evidence!.confidence).toBe('exact');

    // Process evidence should point at the attribute itself, not the whole tag.
    const help = processes(batch).find((p) => p.name === 'button.click' && p.sourceLine === 18);
    expect(help?.evidence).toBeDefined();
    expect(help!.evidence!.snippet).toContain('onclick="openHelp()"');
  });
});

// ──────────────────────────────────────────────────────────────────────
// <form> → ClientSideAPICaller (anchored to per-form fn)
// ──────────────────────────────────────────────────────────────────────

describe('form → ClientSideAPICaller', () => {
  it('emits one caller per <form action> with method extracted', async () => {
    const batch = await extract('index.html');
    const cs = callers(batch);
    expect(cs).toHaveLength(2);

    const login = cs.find((c) => c.urlLiteral === '/api/login');
    expect(login).toBeDefined();
    expect(login!.httpMethod).toBe('POST');
    expect(login!.framework).toBe('html-form');
    expect(login!.egressConfidence).toBe('exact');

    const search = cs.find((c) => c.urlLiteral === '/api/search');
    expect(search).toBeDefined();
    expect(search!.httpMethod).toBe('GET'); // method="get" uppercased
  });

  it('attributes each caller to its own per-form fn via MAKES_REQUEST', async () => {
    const batch = await extract('index.html');
    const formFns = functions(batch).filter((f) => f.name.startsWith('_form_submit_'));
    const formFnIds = new Set(formFns.map((f) => f.id));
    const makes = edgesOfType(batch, 'MAKES_REQUEST');
    expect(makes).toHaveLength(2);
    // Every MAKES_REQUEST originates from a per-form fn (not a shared _document)
    // and lands on the caller for that form.
    for (const e of makes) {
      expect(formFnIds.has(e.from)).toBe(true);
      const c = callers(batch).find((c) => c.id === e.to);
      expect(c).toBeDefined();
    }
    // And distinct per-form fns own distinct callers.
    const sources = new Set(makes.map((e) => e.from));
    expect(sources.size).toBe(2);
  });

  it('flags external URLs and leaves internal ones unflagged', async () => {
    const batch = await extract('external.html');
    const cs = callers(batch);

    const stripe = cs.find((c) => c.urlLiteral?.includes('stripe.com'));
    expect(stripe).toBeDefined();
    expect(stripe!.isExternal).toBe(true);
    expect(stripe!.externalHost).toBe('api.stripe.com');

    const local = cs.find((c) => c.urlLiteral?.includes('localhost'));
    expect(local).toBeDefined();
    expect(local!.isExternal).not.toBe(true);
  });

  it('skips <form> elements without an action attribute and emits no form fn for them', async () => {
    const batch = await extract('external.html');
    // 3 forms but only 2 with action → 2 callers and 2 form fns.
    expect(callers(batch)).toHaveLength(2);
    const formFns = functions(batch).filter((f) => f.name.startsWith('_form_submit_'));
    expect(formFns).toHaveLength(2);
  });

  it('defaults to GET when the form has no method attribute', async () => {
    const batch = await extract('case-and-defaults.html');
    const def = callers(batch).find((c) => c.urlLiteral === '/api/default-method');
    expect(def).toBeDefined();
    expect(def!.httpMethod).toBe('GET');
  });

  it('matches form attributes case-insensitively (HTML semantics)', async () => {
    const batch = await extract('case-and-defaults.html');
    const upper = callers(batch).find((c) => c.urlLiteral === '/api/upper-action');
    expect(upper).toBeDefined();
    expect(upper!.httpMethod).toBe('POST');
  });
});

// ──────────────────────────────────────────────────────────────────────
// inline on* handlers → ClientSideProcess
// ──────────────────────────────────────────────────────────────────────

describe('inline on* handlers → ClientSideProcess', () => {
  it('emits a process per inline event handler attribute', async () => {
    const batch = await extract('index.html');
    const ps = processes(batch);
    // index.html has: button.click (in login form), input.change (search form),
    // button.click (Help), button.mouseover (Help) = 4 handlers.
    expect(ps).toHaveLength(4);
    expect(ps.every((p) => p.kind === 'event_handler')).toBe(true);
    expect(ps.every((p) => p.framework === 'html-inline')).toBe(true);
  });

  it('encodes name as `<tag>.<event>` (event normalized — no "on" prefix) so multiple handlers stay distinct', async () => {
    const batch = await extract('index.html');
    const names = processes(batch).map((p) => p.name).sort();
    expect(names).toEqual([
      'button.click',
      'button.click',
      'button.mouseover',
      'input.change',
    ]);
  });

  it('emits a TRIGGERS edge from every process', async () => {
    const batch = await extract('index.html');
    const triggers = edgesOfType(batch, 'TRIGGERS');
    expect(triggers).toHaveLength(4);
    // Every TRIGGERS originates from a known process.
    for (const e of triggers) {
      const proc = processes(batch).find((p) => p.id === e.from);
      expect(proc).toBeDefined();
    }
  });

  it('does not match attributes that merely start with "on" (e.g., "one")', async () => {
    const batch = await extract('index.html');
    const fromAnchor = processes(batch).find((p) => p.name.startsWith('a.'));
    expect(fromAnchor).toBeUndefined();
  });

  it('matches on* attributes case-insensitively (OnClick, ONCLICK)', async () => {
    const batch = await extract('case-and-defaults.html');
    const inline = processes(batch).filter((p) => p.framework === 'html-inline');
    expect(inline).toHaveLength(2);
    expect(inline.every((p) => p.name === 'button.click')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #173 piece A — submit-trigger DOM walk
// ──────────────────────────────────────────────────────────────────────

describe('submit-trigger DOM walk (#173 piece A)', () => {
  it('routes a submit-button click to the enclosing form fn (not a per-process fn)', async () => {
    const batch = await extract('index.html');
    // The Sign-in button is type=submit inside the /api/login form. Its onclick
    // should TRIGGERS the form fn, which in turn MAKES_REQUEST /api/login.
    expect(processReachesUrl(batch, 'button.click', '/api/login')).toBe(true);
  });

  it('does NOT route a non-form button click to any form (the cross-product is gone)', async () => {
    const batch = await extract('index.html');
    // The Help button is outside any form. Before #173, every process appeared
    // to trigger every form's caller. It must not now reach /api/login or /api/search.
    const help = processes(batch).find((p) => p.name === 'button.click' && p.sourceLine === 18)!;
    const triggers = edgesOfType(batch, 'TRIGGERS').filter((e) => e.from === help.id);
    expect(triggers).toHaveLength(1);
    const target = functions(batch).find((f) => f.id === triggers[0].to);
    // Per-process fn — not a form fn.
    expect(target?.name.startsWith('_form_submit_')).toBe(false);
    expect(target?.name.startsWith('_button_click_')).toBe(true);
  });

  it('does NOT route a non-submit event (onchange) to its parent form', async () => {
    const batch = await extract('index.html');
    // The search-form's <input onchange> is inside the /api/search form, but
    // change is not a submit-causing event. It must get a per-process fn.
    const change = processes(batch).find((p) => p.name === 'input.change')!;
    const triggers = edgesOfType(batch, 'TRIGGERS').filter((e) => e.from === change.id);
    const target = functions(batch).find((f) => f.id === triggers[0].to);
    expect(target?.name.startsWith('_form_submit_')).toBe(false);
    expect(target?.name.startsWith('_input_change_')).toBe(true);
  });

  it('matrix: form/onsubmit, default-type button, type=submit input, type=button, type=text, standalone', async () => {
    const batch = await extract('submit-triggers.html');

    /** Does any flow from this process reach the URL via process → fn (CALLS_FUNCTION* → fn)* → MAKES_REQUEST? */
    const reaches = (snippetMarker: string, url: string): boolean => {
      const proc = processes(batch).find((p) => p.evidence?.snippet?.includes(snippetMarker));
      if (!proc) return false;
      const seen = new Set<string>();
      const queue = edgesOfType(batch, 'TRIGGERS').filter((e) => e.from === proc.id).map((e) => e.to);
      while (queue.length > 0) {
        const fnId = queue.shift()!;
        if (seen.has(fnId)) continue;
        seen.add(fnId);
        for (const m of edgesOfType(batch, 'MAKES_REQUEST').filter((e) => e.from === fnId)) {
          const c = callers(batch).find((c) => c.id === m.to);
          if (c?.urlLiteral === url) return true;
        }
        for (const c of edgesOfType(batch, 'CALLS_FUNCTION').filter((e) => e.from === fnId)) {
          queue.push(c.to);
        }
      }
      return false;
    };

    // Form A: form's own onsubmit — reaches /api/A directly.
    expect(reaches('customA', '/api/A')).toBe(true);
    // A: type=submit click — reaches /api/A via per-process fn → form fn.
    expect(reaches('trackA', '/api/A')).toBe(true);
    // A: type=button click — does NOT submit even inside a form.
    expect(reaches('cancelA', '/api/A')).toBe(false);
    // A: input onchange — change is not submit-causing.
    expect(reaches('searchA', '/api/A')).toBe(false);

    // B: default-type <button onclick> — submits per HTML default.
    expect(reaches('trackB()', '/api/B')).toBe(true);
    // B: <input type=submit onclick> — submits.
    expect(reaches('trackBImg', '/api/B')).toBe(true);

    // C: form has no action → no form fn → submit button click reaches nothing.
    expect(reaches('customSubmitC', '/api/A')).toBe(false);
    expect(reaches('customSubmitC', '/api/B')).toBe(false);

    // Standalone button outside any form reaches nothing.
    expect(reaches('standalone', '/api/A')).toBe(false);
    expect(reaches('standalone', '/api/B')).toBe(false);
  });

  it('passes schema validation across the submit-trigger fixture', async () => {
    const batch = await extract('submit-triggers.html');
    for (const node of batch.nodes) {
      expect(() => validateNode(node)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 2 — Angular template bindings (#170)
// ──────────────────────────────────────────────────────────────────────

describe('Angular (event) bindings', () => {
  it('emits a process per (event)="..." with framework="angular-template"', async () => {
    const batch = await extract('login.component.html');
    const ng = processes(batch).filter((p) => p.framework === 'angular-template');
    // login.component.html has: form.ngSubmit, input.focus, button.click,
    //                           button.click (Help), button.mouseover
    expect(ng).toHaveLength(5);
    expect(ng.every((p) => p.kind === 'event_handler')).toBe(true);
  });

  it('normalizes the event name (no parentheses) and prefixes with the tag', async () => {
    const batch = await extract('login.component.html');
    const names = processes(batch).map((p) => p.name).sort();
    expect(names).toEqual([
      'button.click',
      'button.click',
      'button.mouseover',
      'form.ngSubmit',
      'input.focus',
    ]);
  });

  it('does not emit processes for [property] / [(banana-box)] / # template-ref bindings', async () => {
    const batch = await extract('login.component.html');
    const ngModel = processes(batch).find((p) => p.name.includes('ngModel'));
    expect(ngModel).toBeUndefined();
    const disabled = processes(batch).find((p) => p.name.includes('disabled'));
    expect(disabled).toBeUndefined();
  });

  it('passes schema validation for every emitted node', async () => {
    const batch = await extract('login.component.html');
    for (const node of batch.nodes) {
      expect(() => validateNode(node)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 3 — Vue SFC bindings (#170)
// ──────────────────────────────────────────────────────────────────────

describe('Vue SFC bindings', () => {
  it('emits SourceFile with language="vue" for .vue files', async () => {
    const batch = await extract('Login.vue');
    expect(sourceFiles(batch)[0].language).toBe('vue');
  });

  it('extracts top-level method names from <script> as FunctionDefinition stubs (#173 piece C)', async () => {
    const batch = await extract('Login.vue');
    const fns = functions(batch);
    // Login.vue's <script> defines methods: onSubmit, onFocus, trackClick,
    // openHelp, showTooltip — plus the data() shorthand. data() is filtered
    // by the VUE_KEYWORDS list. The other 5 should appear.
    const names = new Set(fns.map((f) => f.name));
    for (const expected of ['onSubmit', 'onFocus', 'trackClick', 'openHelp', 'showTooltip']) {
      expect(names.has(expected)).toBe(true);
    }
    // Stubs are not exported (lang-html doesn't extract export semantics)
    // and have empty params — they're anchors for resolveInlineHandlers.
    const stub = fns.find((f) => f.name === 'onSubmit')!;
    expect(stub.parameters).toEqual([]);
    expect(stub.returnType).toBeNull();
  });

  it('captures Vue script-setup method bodies in evidence.snippet (Fix 5)', async () => {
    // The resolver scans this snippet to emit cross-file CALLS_FUNCTION
    // edges. Verify the body — not the file or just the name — lands on
    // the stub's evidence field, and that the call-name patterns inside
    // it are still discoverable downstream.
    const batch = await extract('OrderBook.vue');
    const fns = functions(batch);
    const handleCancel = fns.find((f) => f.name === 'handleCancel');
    expect(handleCancel).toBeDefined();
    expect(handleCancel!.evidence?.snippet).toBeDefined();
    expect(handleCancel!.evidence!.snippet).toContain('cancelOrder(id)');
    expect(handleCancel!.evidence!.snippet).toContain('refresh()');
    // refresh() body holds a method call (orders.value = await listOrders())
    // — the SHORTHAND pattern matches `listOrders(` but skips `orders.value`
    // because of the `.` lookbehind in extractCallNames.
    const refresh = fns.find((f) => f.name === 'refresh');
    expect(refresh!.evidence?.snippet).toContain('listOrders()');
    // Multi-line arrow body — `const reloadLater = () =>\n  refresh();`
    // The harvester must skip the leading newline after `=>` to capture
    // `refresh()` in the snippet; otherwise the resolver can't see the call.
    const reloadLater = fns.find((f) => f.name === 'reloadLater');
    expect(reloadLater).toBeDefined();
    expect(reloadLater!.evidence?.snippet).toContain('refresh()');
    // TS object return-type annotation — `function tallyOrders(): { count: number } { … }`.
    // findOpenBraceAfterParams has to recognize the return-type literal
    // and skip to the body brace; otherwise the snippet would contain
    // `count: number` and miss `summarize()`.
    const tallyOrders = fns.find((f) => f.name === 'tallyOrders');
    expect(tallyOrders).toBeDefined();
    expect(tallyOrders!.evidence?.snippet).toContain('summarize()');
    expect(tallyOrders!.evidence?.snippet).not.toContain('count: number');
    // Object default in arrow params — `const openWithDefault = (opts = { size: 10 }) => openDialog(opts)`.
    // The CONST_FN branch has to find `=>` AFTER the param-list close,
    // not inside the param default — otherwise the body would resolve to
    // `size: 10` and `openDialog` would never be discovered.
    const openWithDefault = fns.find((f) => f.name === 'openWithDefault');
    expect(openWithDefault).toBeDefined();
    expect(openWithDefault!.evidence?.snippet).toContain('openDialog(opts)');
    expect(openWithDefault!.evidence?.snippet).not.toContain('size: 10');
    // Body containing a regex literal whose character class includes
    // a `}` — `/^\}+/`. A naive brace counter would underflow at the
    // regex's `}` and either truncate `validateInput`'s body or
    // cascade into the next method. The walker has to recognise
    // expression-position `/.../` and skip past it as a unit.
    const validateInput = fns.find((f) => f.name === 'validateInput');
    expect(validateInput).toBeDefined();
    expect(validateInput!.evidence?.snippet).toContain('doValidate(s)');
    // Sentinel: this method comes right after the regex case and must
    // extract its own independent body. If the regex skip is broken,
    // this assertion catches the cascade.
    const nextAfterRegex = fns.find((f) => f.name === 'nextAfterRegex');
    expect(nextAfterRegex).toBeDefined();
    expect(nextAfterRegex!.evidence?.snippet).toContain('sentinelCall()');
    expect(nextAfterRegex!.evidence?.snippet).not.toContain('doValidate');
    // Pattern 3 `function` branch + TS return-type literal —
    // `const tallyFromExpr = function (): { count: number } { … }`.
    // Different code path from Pattern 2 (`function tallyOrders():
    // { count: number } { … }`); the return-type probe lives in
    // `findOpenBraceAfterParams` which both call sites delegate to.
    const tallyFromExpr = fns.find((f) => f.name === 'tallyFromExpr');
    expect(tallyFromExpr).toBeDefined();
    expect(tallyFromExpr!.evidence?.snippet).toContain('summarizeAgain()');
    expect(tallyFromExpr!.evidence?.snippet).not.toContain('count: number');
    // Arrow expression body containing a string with `;` —
    // `(name) => formatLabel(\`hi;${name}\`)`. `findExprBodyEnd` has
    // to treat the string as opaque or it'd stop at the `;` inside.
    const greet = fns.find((f) => f.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.evidence?.snippet).toContain('formatLabel(');
    // Multi-line arrow with a leading line comment — the body finder
    // skips the comment without marking expression-started, so the
    // body slice extends past the newline to capture `replyTo`.
    const handleNote = fns.find((f) => f.name === 'handleNote');
    expect(handleNote).toBeDefined();
    expect(handleNote!.evidence?.snippet).toContain('replyTo(n)');
  });

  it('extracts Svelte SFC: event handlers + script bodies + brace-attr preservation', async () => {
    // Svelte fixture exercises the brace-wrapping preprocessor's most
    // dangerous paths: a `<` comparison inside the script that must
    // NOT trigger tag-mode entry, an HTML comment whose contents must
    // NOT be rewritten, and three on:click variants (bare ref, inline
    // arrow, modifier).
    const batch = await extract('Counter.svelte');
    const sf = sourceFiles(batch)[0];
    expect(sf.language).toBe('svelte');

    // ClientSideProcess for each event-handler attribute. Bare-ref
    // `={handleClick}` and modifier `|preventDefault={handleSubmit}`
    // both produce processes; the inline arrow also produces one.
    const events = processes(batch).filter((p) => p.framework === 'svelte-template');
    const eventNames = events.map((p) => p.name).sort();
    expect(eventNames).toEqual([
      'button.click', 'button.click', 'button.click',
    ]);

    // Script bodies must extract correctly — `handleClick` body
    // contains the `count<10` comparison that the preprocessor must
    // not have eaten.
    const fns = functions(batch);
    const handleClick = fns.find((f) => f.name === 'handleClick');
    expect(handleClick).toBeDefined();
    expect(handleClick!.evidence?.snippet).toContain('count<10');
    expect(handleClick!.evidence?.snippet).toContain('incrementCounter()');
    const handleSubmit = fns.find((f) => f.name === 'handleSubmit');
    expect(handleSubmit).toBeDefined();
    expect(handleSubmit!.evidence?.snippet).toContain('handleClick()');
  });

  it('filters Vue Options-API top-level keys and lifecycle hooks from script-method emission', async () => {
    const batch = await extract('Login.vue');
    const names = new Set(functions(batch).map((f) => f.name));
    // The fixture's `data()` shorthand is the canonical example; the
    // SHORTHAND regex would otherwise capture it. Filtered by VUE_KEYWORDS.
    expect(names.has('data')).toBe(false);
    // Spot-check a few lifecycle-hook names that aren't in the fixture but
    // would otherwise have been emitted if they appeared. (Adding them
    // here documents intent — they're filtered at the source.)
    for (const lifecycle of ['mounted', 'created', 'beforeUnmount', 'updated']) {
      expect(names.has(lifecycle)).toBe(false);
    }
  });

  it('detects @event and v-on:event bindings, including modifiers like .prevent', async () => {
    const batch = await extract('Login.vue');
    const vue = processes(batch).filter((p) => p.framework === 'vue-template');
    expect(vue).toHaveLength(5);
    const names = vue.map((p) => p.name).sort();
    expect(names).toEqual([
      'button.click',
      'button.click',
      'button.mouseover',
      'form.submit',
      'input.focus',
    ]);
  });

  it('does not pick up v-model / v-bind / data- as event bindings', async () => {
    const batch = await extract('Login.vue');
    const ps = processes(batch);
    expect(ps.find((p) => p.name.includes('v-model'))).toBeUndefined();
    expect(ps.find((p) => p.name.includes('v-bind'))).toBeUndefined();
  });

  it('passes schema validation for every emitted node', async () => {
    const batch = await extract('Login.vue');
    for (const node of batch.nodes) {
      expect(() => validateNode(node)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 4 — Server-rendered templates (#170)
// ──────────────────────────────────────────────────────────────────────

describe('EJS templates', () => {
  it('emits SourceFile with language="ejs" for .ejs files', async () => {
    const batch = await extract('users.ejs');
    expect(sourceFiles(batch)[0].language).toBe('ejs');
  });

  it('detects forms even with embedded EJS expressions in the action', async () => {
    const batch = await extract('users.ejs');
    const cs = callers(batch);
    expect(cs).toHaveLength(2);
    expect(cs.find((c) => c.urlLiteral === '/api/users')).toBeDefined();
    const deleteForm = cs.find((c) => c.urlLiteral?.includes('delete'));
    expect(deleteForm).toBeDefined();
  });

  it('still detects vanilla on* handlers inside EJS files', async () => {
    const batch = await extract('users.ejs');
    const inline = processes(batch).filter((p) => p.framework === 'html-inline');
    expect(inline.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Handlebars templates', () => {
  it('emits SourceFile with language="handlebars" for .hbs files', async () => {
    const batch = await extract('users.hbs');
    expect(sourceFiles(batch)[0].language).toBe('handlebars');
  });

  it('detects forms and inline handlers inside .hbs', async () => {
    const batch = await extract('users.hbs');
    expect(callers(batch)).toHaveLength(1);
    expect(processes(batch).filter((p) => p.framework === 'html-inline')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Jinja-family templates (#183) — Nunjucks, Jinja(2), Twig, Liquid,
// Mustache. All share an HTML body with `{% %}` / `{{ }}` directives
// that tree-sitter-html safely treats as text content.
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// SSG Screens (#198 PR3a) — emitted via end-to-end extractFile
// ──────────────────────────────────────────────────────────────────────

describe('SSG Screen emission (#198 PR3a)', () => {
  it('emits a Screen for an index.html under pages/', async () => {
    const batch = await extract('pages/about/index.html');
    const ss = screens(batch);
    expect(ss).toHaveLength(1);
    expect(ss[0]).toMatchObject({
      name: '/about/',
      routePath: '/about/',
      componentFunctionId: null,
      navigatorKind: 'web-router',
      framework: 'lang-html-ssg',
    });
    expect(() => validateNode(ss[0])).not.toThrow();
  });

  it('emits a Screen for an index.njk under static-site/', async () => {
    const batch = await extract('static-site/blog/post-1/index.njk');
    const ss = screens(batch);
    expect(ss).toHaveLength(1);
    expect(ss[0]).toMatchObject({
      name: '/blog/post-1/',
      routePath: '/blog/post-1/',
      navigatorKind: 'web-router',
    });
  });

  it('does NOT emit a Screen for non-index templates (about-me.html style)', async () => {
    // The existing fixtures `users.njk`, `Login.vue`, `external.html`, etc.
    // are flat files — should not produce Screen nodes under PR3a's
    // index-only convention.
    for (const file of ['users.njk', 'Login.vue', 'external.html', 'submit-triggers.html']) {
      const batch = await extract(file);
      expect(screens(batch), `${file} should not emit a Screen`).toHaveLength(0);
    }
  });

  it('emits a Screen for the basic-fixture root index.html (routePath="/")', async () => {
    const batch = await extract('index.html');
    const ss = screens(batch);
    // Root index.html → routePath "/"
    expect(ss).toHaveLength(1);
    expect(ss[0].routePath).toBe('/');
    expect(ss[0].name).toBe('/');
  });

  it('Screen.id incorporates routePath so two index.html files don\'t collide', async () => {
    const aboutBatch = await extract('pages/about/index.html');
    const blogBatch = await extract('static-site/blog/post-1/index.njk');
    const a = screens(aboutBatch)[0];
    const b = screens(blogBatch)[0];
    expect(a.id).not.toBe(b.id);
  });

  it('emits NAVIGATES_TO edges for <a href> internal links (#198 PR3d)', async () => {
    const batch = await extract('pages/about/index.html');
    const navEdges = edgesOfType(batch, 'NAVIGATES_TO');
    // Internal: /, /about/, /blog/post-1/, /contact, /users/index.html, /search?q=...
    // Skipped: https://example.com, #top, mailto:hello@example.com
    // After normalization: /, /about/, /blog/post-1/, /contact/, /users/, /search/
    expect(navEdges.length).toBe(6);

    const targets = new Set(navEdges.map((e) => e.to));
    // The fixture sets sourceFileId for the about page; all edges
    // should originate from THAT sourceFile id (the screenByOwnSourceFile
    // path in navigation_graph).
    const aboutScreen = screens(batch)[0];
    for (const e of navEdges) {
      expect(e.from).toBe(aboutScreen.sourceFileId);
      expect(e.method).toBe('href');
      expect(typeof e.sourceLine).toBe('number');
    }
    // Six distinct targets expected.
    expect(targets.size).toBe(6);
  });

  it('skips external / fragment / mailto / template-tag hrefs', async () => {
    const batch = await extract('pages/about/index.html');
    const navEdges = edgesOfType(batch, 'NAVIGATES_TO');
    // None of the skipped hrefs should produce an edge. Verify by
    // counting: the fixture has 9 <a> tags total but 6 edges.
    expect(navEdges.length).toBeLessThan(9);
  });
});

describe('Nunjucks templates (#183)', () => {
  it('emits SourceFile with language="nunjucks" for .njk files', async () => {
    const batch = await extract('users.njk');
    expect(sourceFiles(batch)[0].language).toBe('nunjucks');
  });

  it('detects forms even with embedded {% %} directives', async () => {
    const batch = await extract('users.njk');
    const cs = callers(batch);
    expect(cs.find((c) => c.urlLiteral === '/api/users')).toBeDefined();
  });

  it('detects vanilla on* handlers inside .njk files', async () => {
    const batch = await extract('users.njk');
    expect(processes(batch).filter((p) => p.framework === 'html-inline').length).toBeGreaterThan(0);
  });
});

describe('Jinja templates (#183)', () => {
  it('emits SourceFile with language="jinja" for .j2 files', async () => {
    const batch = await extract('users.j2');
    expect(sourceFiles(batch)[0].language).toBe('jinja');
  });

  it('detects forms inside .j2 files', async () => {
    const batch = await extract('users.j2');
    expect(callers(batch).find((c) => c.urlLiteral === '/api/users')).toBeDefined();
  });
});

describe('Twig templates (#183)', () => {
  it('emits SourceFile with language="twig" for .twig files', async () => {
    const batch = await extract('users.twig');
    expect(sourceFiles(batch)[0].language).toBe('twig');
  });

  it('detects forms inside .twig files', async () => {
    const batch = await extract('users.twig');
    expect(callers(batch).find((c) => c.urlLiteral === '/api/users')).toBeDefined();
  });
});

describe('Liquid templates (#183)', () => {
  it('emits SourceFile with language="liquid" for .liquid files', async () => {
    const batch = await extract('users.liquid');
    expect(sourceFiles(batch)[0].language).toBe('liquid');
  });

  it('detects forms inside .liquid files', async () => {
    const batch = await extract('users.liquid');
    expect(callers(batch).find((c) => c.urlLiteral === '/api/users')).toBeDefined();
  });
});

describe('Mustache templates (#183)', () => {
  it('emits SourceFile with language="mustache" for .mustache files', async () => {
    const batch = await extract('users.mustache');
    expect(sourceFiles(batch)[0].language).toBe('mustache');
  });

  it('detects forms inside .mustache files', async () => {
    const batch = await extract('users.mustache');
    expect(callers(batch).find((c) => c.urlLiteral === '/api/users')).toBeDefined();
  });
});
