import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validateNode,
  type ClientSideAPICaller,
  type SchemaNode,
} from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import {
  initObservability,
  resetObservability,
} from '@adorable/observability';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { FetchPlugin, createFetchVisitor } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/fetch');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const plugin = new FetchPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function callers(batch: { nodes: SchemaNode[] }): ClientSideAPICaller[] {
  return batch.nodes.filter(
    (n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller'
  );
}

function findCallerByFunction(
  batch: { nodes: SchemaNode[] },
  fnName: string
): ClientSideAPICaller | undefined {
  const fn = batch.nodes.find((n) => n.nodeType === 'FunctionDefinition' && n.name === fnName);
  if (!fn) return undefined;
  return callers(batch).find((c) => c.functionId === fn.id);
}

// ──────────────────────────────────────────────────────────────────────
// Canonical fetch call detection
// ──────────────────────────────────────────────────────────────────────

describe('canonical fetch call detection', () => {
  it('every emitted caller passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const cs = callers(batch);
    expect(cs.length).toBeGreaterThan(0);
    for (const caller of cs) expect(() => validateNode(caller)).not.toThrow();
  });

  it('plain fetch("/url") → GET with exact egress confidence', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'listUsers');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('GET');
    expect(caller!.urlLiteral).toBe('/api/users');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('fetch(url, { method: "POST" }) extracts POST method', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'createUser');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('POST');
    expect(caller!.urlLiteral).toBe('/api/users');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('template literal URL records the full reconstructed pattern with pattern confidence', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'getUserById');
    expect(caller).toBeDefined();
    // #188: urlLiteral now reflects the FULL reconstructed pattern with
    // `:p0` placeholders for unresolved interpolations, not just the
    // static head.
    expect(caller!.urlLiteral).toBe('/api/users/:p0');
    expect(caller!.httpMethod).toBe('GET');
    expect(caller!.egressConfidence).toBe('pattern');
  });

  it('template literal URL + explicit method stays pattern (url dominates)', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'deleteUser');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/users/:p0');
    expect(caller!.httpMethod).toBe('DELETE');
    expect(caller!.egressConfidence).toBe('pattern');
  });

  it('await fetch(...) still detected via inner CallExpression', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'awaited');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/health');
  });

  it('string-literal property key `"method"` is handled', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'headRequest');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('HEAD');
  });

  it('method is always uppercased', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    for (const caller of callers(batch)) {
      if (caller.httpMethod !== null) {
        expect(caller.httpMethod).toBe(caller.httpMethod.toUpperCase());
      }
    }
  });

  it('framework is "fetch" on every emitted caller', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    for (const caller of callers(batch)) expect(caller.framework).toBe('fetch');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Dynamic / pattern cases
// ──────────────────────────────────────────────────────────────────────

describe('dynamic and pattern cases', () => {
  it('computed URL (identifier) → dynamic with null urlLiteral', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'computedUrl');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBeNull();
    expect(caller!.egressConfidence).toBe('dynamic');
  });

  it('computed URL (call expression) — resolves via #193 pure-function evaluation', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'viaHelper');
    expect(caller).toBeDefined();
    // Pre-#193 was pinned null/dynamic. After #193, buildUrl('/users')
    // — body is `return '/api' + path` — gets inlined: substitute
    // path='/users' → '/api/users'. Test flipped to reflect new behavior.
    expect(caller!.urlLiteral).toBe('/api/users');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('non-literal options object → dynamic method with null httpMethod', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'dynamicOptions');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBeNull();
    expect(caller!.egressConfidence).toBe('dynamic');
  });

  it('literal options but non-literal method value → dynamic', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'dynamicMethod');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBeNull();
    expect(caller!.egressConfidence).toBe('dynamic');
  });

  it('#188: template `${API_BASE}/api/users/${id}` resolves API_BASE and keeps :p0 for id', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'templateWithResolvedConstantHead');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('https://example.com/api/users/:p0');
    expect(caller!.egressConfidence).toBe('pattern');
    expect(caller!.isExternal).toBe(true);
  });

  it('#188: binary `+` chain with resolved constant prefix gets a full reconstructed pattern', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'concatWithConstantPrefix');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/v1/songs/:p0/play');
    expect(caller!.egressConfidence).toBe('pattern');
  });

  it('#188: fully-resolved concat collapses to exact confidence with no placeholders', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'fullyResolvedConcat');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/health');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('template with no static prefix → reconstructed pattern with leading :p0', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'emptyPrefixTemplate');
    expect(caller).toBeDefined();
    // #188: was previously pinned null because the visitor only stored
    // the template head and the head is empty here. Now the full
    // reconstruction surfaces the leading placeholder.
    expect(caller!.urlLiteral).toBe(':p0/api/users');
    expect(caller!.egressConfidence).toBe('pattern');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negatives
// ──────────────────────────────────────────────────────────────────────

describe('negatives', () => {
  it('cache.fetch("key") is not detected (property access, not identifier)', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const fn = batch.nodes.find((n) => n.nodeType === 'FunctionDefinition' && n.name === 'cacheHit');
    expect(fn).toBeDefined();
    const callerInCacheHit = callers(batch).find((c) => c.functionId === fn!.id);
    expect(callerInCacheHit).toBeUndefined();
  });

  it('this.fetch(...) is not detected', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'Thing.doStuff'
    );
    expect(fn).toBeDefined();
    const caller = callers(batch).find((c) => c.functionId === fn!.id);
    expect(caller).toBeUndefined();
  });

  it('new Fetch(...) is not detected', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const fn = batch.nodes.find((n) => n.nodeType === 'FunctionDefinition' && n.name === 'ctor');
    expect(fn).toBeDefined();
    const caller = callers(batch).find((c) => c.functionId === fn!.id);
    expect(caller).toBeUndefined();
  });

  it('module-top-level fetch(...) is silently skipped', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    // The top-level `void fetch('/top-level')` has no enclosing
    // function, so it must not produce a caller node.
    const topLevel = callers(batch).find((c) => c.urlLiteral === '/top-level');
    expect(topLevel).toBeUndefined();
  });

  it('entire negatives.ts file produces zero ClientSideAPICaller nodes', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    expect(callers(batch)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('FetchPlugin contract', () => {
  it('has id="fetch" and language="ts"', () => {
    const plugin = new FetchPlugin();
    expect(plugin.id).toBe('fetch');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true unconditionally (fetch is a platform built-in)', () => {
    const plugin = new FetchPlugin();
    expect(plugin.appliesTo({ rootDir: '/', packageJson: null, files: [] })).toBe(true);
    expect(
      plugin.appliesTo({
        rootDir: '/',
        packageJson: { dependencies: {} },
        files: ['src/index.ts'],
      })
    ).toBe(true);
  });

  it('visitor identity is stable across accesses', () => {
    const plugin = new FetchPlugin();
    expect(plugin.visitor).toBe(plugin.visitor);
  });

  it('the same plugin instance analyzes multiple projects without reset', async () => {
    const plugin = new FetchPlugin();
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);

    const h1 = await ts.loadProject({ rootDir: fixturePath('basic') });
    const b1 = await ts.extractFile(h1, 'src/callers.ts');
    expect(callers(b1).length).toBeGreaterThan(0);

    const h2 = await ts.loadProject({ rootDir: fixturePath('basic') });
    const b2 = await ts.extractFile(h2, 'src/dynamic.ts');
    expect(callers(b2).length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Content-addressed caller id
// ──────────────────────────────────────────────────────────────────────

describe('caller id content-addressing', () => {
  it('two distinct callers in the same file have distinct ids', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const ids = new Set(callers(batch).map((c) => c.id));
    expect(ids.size).toBe(callers(batch).length);
  });

  it('the same caller extracted twice produces the same id', async () => {
    const b1 = await extract('basic', 'src/callers.ts');
    const b2 = await extract('basic', 'src/callers.ts');
    const ids1 = callers(b1).map((c) => c.id).sort();
    const ids2 = callers(b2).map((c) => c.id).sort();
    expect(ids1).toEqual(ids2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end commit to the canonical store
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// URL extraction — extended shapes
// ──────────────────────────────────────────────────────────────────────

describe('URL extraction shapes', () => {
  it('NoSubstitutionTemplateLiteral URL is treated as exact (like StringLiteral)', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'noSubstTemplate');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/status');
    expect(caller!.egressConfidence).toBe('exact');
    expect(caller!.httpMethod).toBe('GET');
  });

  it('template with interpolation in the MIDDLE includes both halves around :p0', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'middleInterp');
    expect(caller).toBeDefined();
    // #188: full reconstruction picks up `/posts` after the placeholder.
    expect(caller!.urlLiteral).toBe('/api/users/:p0/posts');
    expect(caller!.egressConfidence).toBe('pattern');
  });

  it.each<[string, string | null, 'exact' | 'pattern' | 'dynamic']>([
    ['listUsers', '/api/users', 'exact'],
    ['noSubstTemplate', '/api/status', 'exact'],
    // #188: full reconstruction with :p0 placeholders.
    ['getUserById', '/api/users/:p0', 'pattern'],
    ['middleInterp', '/api/users/:p0/posts', 'pattern'],
    ['emptyPrefixTemplate', ':p0/api/users', 'pattern'],
    ['computedUrl', null, 'dynamic'],
    ['viaHelper', '/api/users', 'exact'], // #193: pure-fn resolves

    // #188: binary `+` concat is now resolved through resolveUrlPattern;
    // previously the bespoke fetch path bailed to dynamic.
    ['concatString', '/api/:p0', 'pattern'],
    ['urlObject', null, 'dynamic'],
    ['requestObject', null, 'dynamic'],
    ['toStringChain', null, 'dynamic'],
  ])('URL shape %s → urlLiteral=%j, confidence=%s', async (fnName, expectedUrl, expectedConf) => {
    // `callers.ts` holds the exact/pattern cases; `dynamic.ts` the rest.
    const file = ['concatString', 'urlObject', 'requestObject', 'toStringChain', 'computedUrl', 'viaHelper', 'emptyPrefixTemplate'].includes(
      fnName
    )
      ? 'src/dynamic.ts'
      : 'src/callers.ts';
    const batch = await extract('basic', file);
    const caller = findCallerByFunction(batch, fnName);
    expect(caller, `caller for ${fnName}`).toBeDefined();
    expect(caller!.urlLiteral).toBe(expectedUrl);
    expect(caller!.egressConfidence).toBe(expectedConf);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Method extraction — extended shapes
// ──────────────────────────────────────────────────────────────────────

describe('method extraction shapes', () => {
  it('lowercase literal method value is uppercased', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'lowercaseMethod');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('POST');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('spread BEFORE the explicit method still finds the literal method', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'spreadBeforeMethod');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('PUT');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('spread AFTER the explicit method returns the literal method (first match wins)', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'spreadAfterMethod');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('PATCH');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('wrong-case key METHOD is ignored and the call defaults to GET', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'wrongCaseKey');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('GET');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('computed property-name key is skipped and the call defaults to GET', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'computedKey');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('GET');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('{ method: undefined } is treated as dynamic', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'methodUndefined');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBeNull();
    expect(caller!.egressConfidence).toBe('dynamic');
  });

  // #2 — type-checker resolution of `opts` variable to its declaration.
  it('#2 — opts variable referencing a same-file const object literal recovers the method', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'viaLocalOptsConst');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('POST');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('#2 — typed RequestInit const resolves the method', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'viaTypedOptsConst');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('PUT');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('#2 — chained alias const traces through one indirection', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'viaAliasOptsConst');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('POST');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('#2 — function-parameter opts (unresolvable) still degrades to dynamic', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'viaParamOpts');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBeNull();
    expect(caller!.egressConfidence).toBe('dynamic');
  });

  it('#2 — `let` opts (could be reassigned) is conservatively treated as dynamic', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'viaLetOpts');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBeNull();
    expect(caller!.egressConfidence).toBe('dynamic');
  });

  it('#2 — cross-file imported opts const resolves to exact method', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const caller = findCallerByFunction(batch, 'viaImportedOpts');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('DELETE');
    expect(caller!.egressConfidence).toBe('exact');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Confidence composition — all four URL × method combinations
// ──────────────────────────────────────────────────────────────────────

describe('egress confidence composition', () => {
  it('URL exact + method exact → exact', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const c = findCallerByFunction(batch, 'createUser');
    expect(c!.egressConfidence).toBe('exact');
  });

  it('URL pattern + method exact → pattern', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const c = findCallerByFunction(batch, 'deleteUser');
    expect(c!.egressConfidence).toBe('pattern');
  });

  it('URL exact + method dynamic → dynamic', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const c = findCallerByFunction(batch, 'urlExactMethodDynamic');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toBe('/api/users');
    expect(c!.httpMethod).toBeNull();
    expect(c!.egressConfidence).toBe('dynamic');
  });

  it('URL pattern + method dynamic → dynamic (dynamic beats pattern)', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const c = findCallerByFunction(batch, 'urlPatternMethodDynamic');
    expect(c).toBeDefined();
    // #188: urlLiteral carries the full reconstructed pattern even when
    // overall egressConfidence is collapsed to 'dynamic' by a non-literal
    // method value.
    expect(c!.urlLiteral).toBe('/api/users/:p0');
    expect(c!.httpMethod).toBeNull();
    expect(c!.egressConfidence).toBe('dynamic');
  });

  it('URL dynamic + method exact → dynamic', async () => {
    const batch = await extract('basic', 'src/dynamic.ts');
    const c = findCallerByFunction(batch, 'computedUrl');
    expect(c!.egressConfidence).toBe('dynamic');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Enclosing-function attribution
// ──────────────────────────────────────────────────────────────────────

describe('enclosing function attribution', () => {
  it('fetch inside a nested arrow attributes to the inner arrow, not the outer function', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const cs = callers(batch);
    const innerCaller = cs.find((c) => c.urlLiteral === '/api/inner');
    expect(innerCaller).toBeDefined();
    const innerFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'inner'
    );
    const outerFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'outerWithNestedArrow'
    );
    expect(innerFn).toBeDefined();
    expect(outerFn).toBeDefined();
    expect(innerCaller!.functionId).toBe(innerFn!.id);
    expect(innerCaller!.functionId).not.toBe(outerFn!.id);
  });

  it('every emitted caller has a functionId that resolves to a FunctionDefinition in the same batch', async () => {
    for (const file of ['src/callers.ts', 'src/dynamic.ts']) {
      const batch = await extract('basic', file);
      const fnIds = new Set(
        batch.nodes
          .filter((n): n is Extract<SchemaNode, { nodeType: 'FunctionDefinition' }> => n.nodeType === 'FunctionDefinition')
          .map((f) => f.id)
      );
      for (const c of callers(batch)) {
        expect(c.functionId).toBeTruthy();
        expect(fnIds.has(c.functionId)).toBe(true);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Shadowed / re-assigned fetch — known false positives
// ──────────────────────────────────────────────────────────────────────

describe('shadowed local fetch (#9 guard)', () => {
  it('a local `const fetch = (_url) => null` is NOT detected (was a pinned false positive)', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const cs = callers(batch);
    const shadowed = cs.find((c) => c.urlLiteral === '/api/shadowed');
    expect(shadowed).toBeUndefined();
  });

  it('a local `function fetch(...)` declaration is NOT detected', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const cs = callers(batch);
    const shadowed = cs.find((c) => c.urlLiteral === '/api/shadowed-fn');
    expect(shadowed).toBeUndefined();
  });

  it('shadowed wrapper-name (`fetchApi`) is also NOT detected — guard applies to all members of FETCH_WRAPPER_NAMES', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const cs = callers(batch);
    const shadowed = cs.find((c) => c.urlLiteral === '/api/shadowed-wrapper');
    expect(shadowed).toBeUndefined();
  });

  it('aliased global (`const fetch = fetchFromUndici` — typeof globalThis.fetch) IS still detected', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const cs = callers(batch);
    const undici = cs.find((c) => c.urlLiteral === '/api/undici');
    expect(undici).toBeDefined();
  });

  it('real `import { fetch } from "./undici-stub"` IS still detected — ImportSpecifier is not a function-shape decl', async () => {
    const batch = await extract('basic', 'src/imported-fetch.ts');
    const cs = callers(batch);
    const imported = cs.find((c) => c.urlLiteral === '/api/imported');
    expect(imported).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negatives — window.fetch / globalThis.fetch pinned as not detected
// ──────────────────────────────────────────────────────────────────────

describe('negatives — window/globalThis.fetch pinned', () => {
  it('window.fetch(...) is not detected (PropertyAccessExpression)', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'viaWindow'
    );
    expect(fn).toBeDefined();
    const caller = callers(batch).find((c) => c.functionId === fn!.id);
    expect(caller).toBeUndefined();
  });

  it('globalThis.fetch(...) is not detected (PropertyAccessExpression)', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'viaGlobalThis'
    );
    expect(fn).toBeDefined();
    const caller = callers(batch).find((c) => c.functionId === fn!.id);
    expect(caller).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract — appliesTo exhaustiveness
// ──────────────────────────────────────────────────────────────────────

describe('appliesTo is always true', () => {
  it.each([
    { rootDir: '/', packageJson: null, files: [] },
    { rootDir: '/', packageJson: null, files: ['src/index.ts', 'src/app.tsx'] },
    { rootDir: '/', packageJson: { dependencies: { react: '^18.0.0' } }, files: [] },
    { rootDir: '/', packageJson: { dependencies: {} }, files: [] },
    { rootDir: '/proj', packageJson: { name: 'x' }, files: ['a.ts'] },
  ])('appliesTo(%j) → true', (ctx) => {
    const plugin = new FetchPlugin();
    expect(plugin.appliesTo(ctx)).toBe(true);
  });

  it('createFetchVisitor returns a stateless TS visitor', () => {
    const v1 = createFetchVisitor();
    const v2 = createFetchVisitor();
    expect(v1.language).toBe('ts');
    expect(v2.language).toBe('ts');
    // Different instances — statelessness means fresh per call is fine.
    expect(typeof v1.onNode).toBe('function');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Confidence-decision span events (the hard rule from #67)
// ──────────────────────────────────────────────────────────────────────

describe('confidence decision span events', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(async () => {
    await resetObservability();
    exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    initObservability({ provider });
  });

  afterEach(async () => {
    await resetObservability();
  });

  it('pattern and dynamic classifications record ConfidenceDecision span events; pure exact calls do not', async () => {
    const plugin = new FetchPlugin();
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

    await ts.extractFile(handle, 'src/callers.ts');
    await ts.extractFile(handle, 'src/dynamic.ts');

    const spans = exporter.getFinishedSpans();
    const allEvents = spans.flatMap((s) => s.events);
    const decisions = allEvents.filter(
      (e) => e.name === 'ConfidenceDecision' && e.attributes?.['fetch.egress'] !== undefined
    );
    expect(decisions.length).toBeGreaterThan(0);

    const egressValues = decisions.map((e) => String(e.attributes?.['fetch.egress']));
    expect(egressValues).toContain('pattern');
    expect(egressValues).toContain('dynamic');
    // No ConfidenceDecision event should carry `fetch.egress = 'exact'`.
    expect(egressValues).not.toContain('exact');
  });

  it('a file with only exact fetch calls records no ConfidenceDecision events', async () => {
    const plugin = new FetchPlugin();
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(plugin.visitor);
    const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

    // Extract only negatives.ts — no detections, no decisions.
    await ts.extractFile(handle, 'src/negatives.ts');

    const spans = exporter.getFinishedSpans();
    const decisions = spans
      .flatMap((s) => s.events)
      .filter(
        (e) =>
          e.name === 'ConfidenceDecision' && e.attributes?.['fetch.egress'] !== undefined
      );
    expect(decisions).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Wrapper-class call sites (#182, half A)
// ──────────────────────────────────────────────────────────────────────

describe('wrapper-class call sites (#182)', () => {
  it('emits a caller per use site of a fetch-wrapper class method', async () => {
    const batch = await extract('basic', 'src/wrapper-class.ts');
    const cs = callers(batch);
    // 3 explicit literal-name use sites + 1 dynamic + 1 ctor-assign external + the internal
    // fetch in the wrapper definitions themselves (POST + GET).
    const urls = cs.map((c) => c.urlLiteral).filter((u): u is string => u !== null);
    expect(urls).toContain('/api/jade?r=GenerateBundle');
    expect(urls).toContain('/api/jade?r=GetBundle');
    expect(urls).toContain('/api/account?r=GetAccountData');
  });

  it('attributes the wrapper caller to the calling function, not the wrapper definition', async () => {
    const batch = await extract('basic', 'src/wrapper-class.ts');
    const generateBundleCaller = findCallerByFunction(batch, 'generateBundle');
    expect(generateBundleCaller).toBeDefined();
    expect(generateBundleCaller!.urlLiteral).toBe('/api/jade?r=GenerateBundle');
    expect(generateBundleCaller!.httpMethod).toBe('POST');
    expect(generateBundleCaller!.egressConfidence).toBe('exact');
  });

  it('marks dynamic first arg as `pattern` confidence with the static prefix', async () => {
    const batch = await extract('basic', 'src/wrapper-class.ts');
    const dyn = findCallerByFunction(batch, 'postDynamic');
    expect(dyn).toBeDefined();
    expect(dyn!.egressConfidence).toBe('pattern');
    // The base URL still resolves; only the request-name span is unknown.
    expect(dyn!.urlLiteral).toBe('/api/jade?r=');
    // The static parts capture the surrounding template literals so the
    // stitcher can still pattern-match against `/api/jade?r=:name`.
    expect(dyn!.templateParts).toEqual(['', '?r=', '']);
  });

  it('detects a wrapper that uses constructor-body assignment instead of parameter property', async () => {
    const batch = await extract('basic', 'src/wrapper-class.ts');
    const ext = findCallerByFunction(batch, 'externalGet');
    expect(ext).toBeDefined();
    // The path is dynamic (passed in as a function arg), so we get
    // the static prefix only.
    expect(ext!.urlLiteral).toBe('https://example.com');
    expect(ext!.egressConfidence).toBe('pattern');
    // External-host detection should still fire on the prefix.
    expect(ext!.isExternal).toBe(true);
  });

  it('does not match a non-fetch wrapper class method (no fetch in body)', async () => {
    const batch = await extract('basic', 'src/wrapper-class.ts');
    const greeterCalls = callers(batch).filter(
      (c) => c.urlLiteral && c.urlLiteral.includes('hello'),
    );
    expect(greeterCalls).toHaveLength(0);
  });

  it('every emitted wrapper caller passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/wrapper-class.ts');
    for (const c of callers(batch)) {
      expect(() => validateNode(c)).not.toThrow();
    }
  });

  it('resolves a wrapper class declared in another file (cross-file)', async () => {
    const batch = await extract('basic', 'src/wrapper-defined-elsewhere.ts');
    const literal = findCallerByFunction(batch, 'callWithLiteralName');
    expect(literal).toBeDefined();
    expect(literal!.urlLiteral).toBe('/api/cross-file?r=CrossFileLiteral');
    expect(literal!.httpMethod).toBe('POST');
    expect(literal!.egressConfidence).toBe('exact');
  });

  it('handles destructured ctor params + method name "sendRequest" + this.field receiver (test-code-comprehension shape)', async () => {
    const batch = await extract('basic', 'src/wrapper-class.ts');
    // Class method names are emitted as `${className}.${methodName}`.
    const ep = findCallerByFunction(batch, 'API.generateBundleViaApiClass');
    expect(ep).toBeDefined();
    expect(ep!.urlLiteral).toBe('/api/jade?r=GenerateBundle');
    expect(ep!.httpMethod).toBe('POST');
    expect(ep!.egressConfidence).toBe('exact');
  });
});

describe('free-function wrapper call sites (#8b)', () => {
  it('detects `apiGet(url)` and resolves the URL from the call-site literal', async () => {
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const caller = findCallerByFunction(batch, 'listUsersViaWrapper');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/users');
    expect(caller!.httpMethod).toBe('GET');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('preserves the wrapper-provided HTTP method (POST)', async () => {
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const caller = findCallerByFunction(batch, 'createUserViaWrapper');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/users');
    expect(caller!.httpMethod).toBe('POST');
  });

  it('arrow-function wrapper (DELETE) is also recognized', async () => {
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const caller = findCallerByFunction(batch, 'deleteUserViaWrapper');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/users/42');
    expect(caller!.httpMethod).toBe('DELETE');
  });

  it('multi-parameter wrapper substitutes only the url parameter', async () => {
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const caller = findCallerByFunction(batch, 'callWithBody');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/items');
    expect(caller!.httpMethod).toBe('POST');
  });

  it('ambiguous wrapper body (multiple fetch calls) does NOT produce a resolved caller for the call site', async () => {
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const caller = findCallerByFunction(batch, 'ambiguousCallSite');
    // ambiguousCallSite calls `apiAmbiguous` whose body has 2 fetch
    // calls — the resolver bails. There should be no caller attributed
    // to ambiguousCallSite (the wrapper's own inner fetch attributes
    // to apiAmbiguous, not its call sites).
    expect(caller).toBeUndefined();
  });

  it('non-literal call-site argument falls back to no resolved caller', async () => {
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const caller = findCallerByFunction(batch, 'nonLiteralCallSite');
    expect(caller).toBeUndefined();
  });

  it('cross-file imported wrapper resolves via lang-ts type-checker-first (GET)', async () => {
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const caller = findCallerByFunction(batch, 'listViaImportedWrapper');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/imported-list');
    expect(caller!.httpMethod).toBe('GET');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('cross-file imported wrapper preserves explicit POST method', async () => {
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const caller = findCallerByFunction(batch, 'postViaImportedWrapper');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/imported-post');
    expect(caller!.httpMethod).toBe('POST');
  });

  it('inner-fetch attribution is preserved alongside resolved call-site emission', async () => {
    // Regression: the wrapper file also gets walked, so the inner
    // `fetch(url)` inside `apiGet` itself emits a `dynamic`-egress
    // ClientSideAPICaller attributed to `apiGet`. The new resolved
    // call-site emissions should NOT replace that inner caller.
    const batch = await extract('basic', 'src/free-function-wrapper.ts');
    const inner = callers(batch).find(
      (c) => c.urlLiteral === null && c.egressConfidence === 'dynamic',
    );
    expect(inner).toBeDefined();
  });
});

describe('wrapper-class inheritance walk (#207)', () => {
  it('detects a fetch caller through a one-level inherited post() method', async () => {
    const batch = await extract('basic', 'src/wrapper-inheritance.ts');
    // UserAPI extends BasePostClient. UserAPI has no own post(), so
    // the resolver must walk getBaseClass() to find it.
    const c = findCallerByFunction(batch, 'callInheritedOneLevel');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toBe('/api/users?r=GetUser');
    expect(c!.httpMethod).toBe('POST');
    expect(c!.egressConfidence).toBe('exact');
  });

  it('detects a fetch caller through a two-level inherited method', async () => {
    const batch = await extract('basic', 'src/wrapper-inheritance.ts');
    // AuthenticatedUserAPI extends UserAPI extends BasePostClient.
    // post() lives two levels up.
    const c = findCallerByFunction(batch, 'callInheritedTwoLevels');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toBe('/api/auth?r=GetAuth');
    expect(c!.httpMethod).toBe('POST');
  });

  it('every emitted inherited-wrapper caller passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/wrapper-inheritance.ts');
    for (const c of callers(batch)) {
      expect(() => validateNode(c)).not.toThrow();
    }
  });
});

describe('URL-builder methods (#196)', () => {
  it('emits ClientSideAPICaller for `api.generateJadeDownloadUrl(id)`', async () => {
    const batch = await extract('basic', 'src/url-builders.ts');
    const c = findCallerByFunction(batch, 'startJadeDownload');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toContain('/api/jade/jade');
    expect(c!.httpMethod).toBe('GET');
  });

  it('emits ClientSideAPICaller for fully-qualified URL builder', async () => {
    const batch = await extract('basic', 'src/url-builders.ts');
    const c = findCallerByFunction(batch, 'externalDownloadUrl');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toContain('https://cdn.example.com/files/');
  });

  it('does NOT emit ClientSideAPICaller for non-URL string returns', async () => {
    const batch = await extract('basic', 'src/url-builders.ts');
    const c = findCallerByFunction(batch, 'userLabel');
    expect(c).toBeUndefined();
  });
});

describe('end-to-end with canonical store', () => {
  it('callers commit cleanly and every functionId resolves to a real FunctionDefinition', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new FetchPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(plugin.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      for (const file of ['src/callers.ts', 'src/dynamic.ts']) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allCallers = store.findNodes('ClientSideAPICaller');
      expect(allCallers.length).toBeGreaterThan(0);
      for (const caller of allCallers) {
        expect(caller.framework).toBe('fetch');
        const fn = store.getNode('FunctionDefinition', caller.functionId);
        expect(fn).not.toBeNull();
      }
    } finally {
      store.close();
    }
  });
});
