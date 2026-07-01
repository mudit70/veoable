import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type ClientSideAPICaller,
  type SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { SupabasePlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/supabase');

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const supabase = new SupabasePlugin();
  const ts = new TsLanguagePlugin();
  // The visitor is constructed lazily; trigger initialization without
  // requiring ProjectContext (the visitor doesn't actually need a real
  // DatabaseSystem id for the .functions.invoke detection branch).
  ts.registerVisitor(supabase.visitor);
  const handle = await ts.loadProject({ rootDir: path.join(FIXTURE_ROOT, scenario) });
  return ts.extractFile(handle, file);
}

function callers(batch: { nodes: SchemaNode[] }): ClientSideAPICaller[] {
  return batch.nodes.filter(
    (n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller',
  );
}

function findCallerByFunction(
  batch: { nodes: SchemaNode[] },
  fnName: string,
): ClientSideAPICaller | undefined {
  const fn = batch.nodes.find(
    (n) => n.nodeType === 'FunctionDefinition' && (n as { name: string }).name === fnName,
  );
  if (!fn) return undefined;
  return callers(batch).find((c) => c.functionId === fn.id);
}

describe('supabase.functions.invoke detection (#191)', () => {
  it('emits ClientSideAPICaller for `supabase.functions.invoke("hello")`', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    const c = findCallerByFunction(batch, 'callHello');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toBe('/functions/v1/hello');
    expect(c!.httpMethod).toBe('POST');
    expect(c!.framework).toBe('supabase-functions');
    expect(c!.egressConfidence).toBe('exact');
  });

  it('handles `supabase.functions.invoke(name, { body })` form', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    const c = findCallerByFunction(batch, 'callBillingWebhook');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toBe('/functions/v1/billing-webhook');
  });

  it('handles no-substitution template literal as function name', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    const c = findCallerByFunction(batch, 'callWithBacktick');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toBe('/functions/v1/hello');
  });

  it('matches `this.supabase.functions.invoke(...)` chains', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    // Class methods are emitted as `<ClassName>.<methodName>`.
    const c = findCallerByFunction(batch, 'Service.run');
    expect(c).toBeDefined();
    expect(c!.urlLiteral).toBe('/functions/v1/hello');
  });

  it('does NOT emit for computed function names (conservative skip)', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    const c = findCallerByFunction(batch, 'dynamicInvoke');
    expect(c).toBeUndefined();
  });

  it('does NOT emit for non-Supabase receivers (`.functions.invoke()` on other SDKs)', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    const c = findCallerByFunction(batch, 'otherInvoke');
    expect(c).toBeUndefined();
  });

  it('does NOT emit for plain `.invoke()` without `.functions` prefix', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    const c = findCallerByFunction(batch, 'plainInvoke');
    expect(c).toBeUndefined();
  });

  it('every emitted ClientSideAPICaller passes schema validation', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    for (const c of callers(batch)) {
      expect(() => validateNode(c)).not.toThrow();
    }
  });

  it('emits MAKES_REQUEST edge from enclosing function to caller', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    const makesEdges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    // 4 positive cases (callHello, callBillingWebhook, callWithBacktick, run)
    expect(makesEdges.length).toBeGreaterThanOrEqual(4);
  });
});

describe('chained query dedup (#252)', () => {
  function interactions(batch: { nodes: SchemaNode[] }) {
    return batch.nodes.filter(
      (n): n is SchemaNode & { operation: string; callSiteFunctionId: string } =>
        n.nodeType === 'DatabaseInteraction',
    );
  }

  function findFn(batch: { nodes: SchemaNode[] }, name: string) {
    return batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && (n as { name: string }).name === name,
    );
  }

  function interactionsForFn(batch: { nodes: SchemaNode[] }, fnName: string) {
    const fn = findFn(batch, fnName);
    if (!fn) return [];
    return interactions(batch).filter((i) => i.callSiteFunctionId === fn.id);
  }

  it('select+single chain emits ONE read interaction (not 2)', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'getUser');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('read');
  });

  it('select+maybeSingle chain emits ONE read interaction', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'findUser');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('read');
  });

  it('insert+select+single chain emits ONE WRITE (write precedence over read)', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'createUser');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('write');
  });

  it('update+select+single chain emits ONE UPDATE', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'renameUser');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('update');
  });

  it('delete+select+single chain emits ONE DELETE', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'removeUser');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('delete');
  });

  it('bare select emits ONE read (no regression on simple chains)', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'listUsers');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('read');
  });

  it('two separate chains in one function emit TWO interactions', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'readAndLog');
    expect(ints.length).toBe(2);
    const ops = ints.map((i) => i.operation).sort();
    expect(ops).toEqual(['read', 'write']);
  });

  it('filter methods (.gt/.in/.order/.range) in the middle of a chain do not break dedup', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'filteredQuery');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('read');
  });

  it('upsert+select+single chain emits ONE write', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'upsertUser');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('write');
  });

  it('non-null assertion (`from(t)!`) mid-chain still dedupes', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'insertWithBang');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('write');
  });

  it('parenthesized receiver mid-chain still dedupes', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'parenChain');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('read');
  });

  it('type assertion (`... as any`) mid-chain still dedupes', async () => {
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'castChain');
    expect(ints.length).toBe(1);
    expect(ints[0].operation).toBe('read');
  });

  it('two same-table same-op chains in one fn collapse to one canonical id', async () => {
    // The visitor emits two distinct nodes; idFor.databaseInteraction
    // hashes (callSiteFunctionId, operation, targetTableId), so the
    // two nodes share an id. The canonical store dedupes by id on
    // insert. Either we observe one or two emitted nodes here, but
    // they MUST share the same id.
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const ints = interactionsForFn(batch, 'twoSameTableReads');
    expect(ints.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(ints.map((i) => i.id));
    expect(ids.size).toBe(1);
  });
});

describe('Edge Function handler resolution (#254)', () => {
  function endpoints(batch: { nodes: SchemaNode[] }) {
    return batch.nodes.filter(
      (n): n is SchemaNode & {
        framework: string;
        routePattern: string;
        handlerFunctionId: string | null;
      } => n.nodeType === 'APIEndpoint',
    );
  }
  function functions(batch: { nodes: SchemaNode[] }) {
    return batch.nodes.filter(
      (n): n is SchemaNode & { name: string } => n.nodeType === 'FunctionDefinition',
    );
  }

  it('serve(arrow) form (std/http) → endpoint with resolved handlerFunctionId', async () => {
    const batch = await extract(
      'edge-handler-resolution',
      'supabase/functions/std-serve/index.ts',
    );
    const eps = endpoints(batch).filter((e) => e.framework === 'supabase-edge');
    expect(eps.length).toBe(1);
    expect(eps[0].routePattern).toBe('/functions/v1/std-serve');
    expect(eps[0].handlerFunctionId).not.toBeNull();
    // The handlerFunctionId must reference a FunctionDefinition that
    // lang-ts emitted in the same file.
    const fn = functions(batch).find((f) => f.id === eps[0].handlerFunctionId);
    expect(fn).toBeDefined();
    expect(fn!.name).toBe('<module>.serve$handler');
  });

  it('Deno.serve(arrow) form → endpoint with resolved handlerFunctionId', async () => {
    const batch = await extract(
      'edge-handler-resolution',
      'supabase/functions/deno-serve/index.ts',
    );
    const eps = endpoints(batch).filter((e) => e.framework === 'supabase-edge');
    expect(eps.length).toBe(1);
    expect(eps[0].routePattern).toBe('/functions/v1/deno-serve');
    expect(eps[0].handlerFunctionId).not.toBeNull();
    const fn = functions(batch).find((f) => f.id === eps[0].handlerFunctionId);
    expect(fn).toBeDefined();
  });

  it('Deno.serve(options, handler) form → handler is the function-shaped arg', async () => {
    const batch = await extract(
      'edge-handler-resolution',
      'supabase/functions/options-form/index.ts',
    );
    const eps = endpoints(batch).filter((e) => e.framework === 'supabase-edge');
    expect(eps.length).toBe(1);
    expect(eps[0].handlerFunctionId).not.toBeNull();
    const fn = functions(batch).find((f) => f.id === eps[0].handlerFunctionId);
    expect(fn).toBeDefined();
  });

  it('serve() wrapped inside a function uses the wrapper name as prefix', async () => {
    // The arrow inside `function bootstrap() { serve(arrow) }` is
    // emitted by lang-ts as `bootstrap.serve$handler`. The visitor
    // must use the enclosing function's name as the prefix (NOT the
    // hardcoded '<module>') so the FunctionDefinition.id resolves.
    const batch = await extract(
      'edge-handler-resolution',
      'supabase/functions/wrapped-serve/index.ts',
    );
    const eps = endpoints(batch).filter((e) => e.framework === 'supabase-edge');
    expect(eps.length).toBe(1);
    expect(eps[0].handlerFunctionId).not.toBeNull();
    const fn = functions(batch).find((f) => f.id === eps[0].handlerFunctionId);
    expect(fn).toBeDefined();
    expect(fn!.name).toBe('bootstrap.serve$handler');
  });

  it('multiple serve() calls in one file collapse to one APIEndpoint (first wins)', async () => {
    const batch = await extract(
      'edge-handler-resolution',
      'supabase/functions/multi-serve/index.ts',
    );
    const eps = endpoints(batch).filter((e) => e.framework === 'supabase-edge');
    // Exactly one Edge endpoint emitted, not two.
    expect(eps.length).toBe(1);
    expect(eps[0].handlerFunctionId).not.toBeNull();
    // The handler resolution must point at a real FunctionDefinition.
    const fn = functions(batch).find((f) => f.id === eps[0].handlerFunctionId);
    expect(fn).toBeDefined();
  });

  it('does NOT emit an Edge endpoint for a non-edge file path', async () => {
    // The chain-dedup fixture has src/queries.ts which is NOT under
    // supabase/functions/. Even though it has Supabase calls, no
    // Edge endpoint should be synthesized.
    const batch = await extract('chain-dedup', 'src/queries.ts');
    const eps = endpoints(batch).filter((e) => e.framework === 'supabase-edge');
    expect(eps.length).toBe(0);
  });
});

describe('integration with #190 — invoke URL matches Edge Function endpoint', () => {
  it('invoke caller URL `/functions/v1/hello` matches the route pattern emitted by extractEdgeFunctions', async () => {
    const batch = await extract('invoke-client', 'src/api.ts');
    const c = findCallerByFunction(batch, 'callHello');
    expect(c).toBeDefined();
    // The URL must EXACTLY match what edgeFunctionRoutePattern('hello')
    // produces — that's the stitching primitive the flow walker uses.
    expect(c!.urlLiteral).toBe('/functions/v1/hello');
  });
});
