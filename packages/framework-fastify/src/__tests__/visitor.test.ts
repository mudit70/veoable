import * as path from 'node:path';
import * as url from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { APIEndpoint } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { createFastifyVisitor } from '../visitor.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/fastify');

const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(createFastifyVisitor());
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: NodeBatch): APIEndpoint[] {
  return batch.nodes.filter(
    (n): n is APIEndpoint => n.nodeType === 'APIEndpoint'
  );
}

// ──────────────────────────────────────────────────────────────────────
// Route detection
// ──────────────────────────────────────────────────────────────────────

describe('Fastify route detection', () => {
  it('detects all routes in server.ts', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBe(5);
  });

  it('detects GET /api/users', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const ep = endpoints(batch).find(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/api/users'
    );
    expect(ep).toBeDefined();
    expect(ep!.framework).toBe('fastify');
  });

  it('detects GET /api/users/:id', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const ep = endpoints(batch).find(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/api/users/:id'
    );
    expect(ep).toBeDefined();
  });

  it('detects POST /api/users', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const ep = endpoints(batch).find(
      (e) => e.httpMethod === 'POST' && e.routePattern === '/api/users'
    );
    expect(ep).toBeDefined();
  });

  it('detects DELETE /api/users/:id (inline handler resolved)', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const ep = endpoints(batch).find(
      (e) => e.httpMethod === 'DELETE' && e.routePattern === '/api/users/:id'
    );
    expect(ep).toBeDefined();
    // Inline handler now resolved to the callback's FunctionDefinition.
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  it('detects PUT /api/users/:id (options object handler)', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const ep = endpoints(batch).find(
      (e) => e.httpMethod === 'PUT' && e.routePattern === '/api/users/:id'
    );
    expect(ep).toBeDefined();
    // Options object with inline handler — resolved when the handler
    // is an inline function, null for shorthand { handler }.
  });

  it('every endpoint has framework=fastify', async () => {
    const batch = await extract('basic', 'src/server.ts');
    for (const ep of endpoints(batch)) {
      expect(ep.framework).toBe('fastify');
    }
  });

  it('every endpoint passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/server.ts');
    // If validation failed, extractFile would have thrown.
    expect(endpoints(batch).length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Handler resolution
// ──────────────────────────────────────────────────────────────────────

describe('@fastify/websocket detection (#110)', () => {
  it('emits httpMethod=WS + framework=fastify-websocket when { websocket: true }', async () => {
    const batch = await extract('basic', 'src/websocket.ts');
    const wsEp = endpoints(batch).find((e) => e.routePattern === '/ws');
    expect(wsEp).toBeDefined();
    expect(wsEp!.httpMethod).toBe('WS');
    expect(wsEp!.framework).toBe('fastify-websocket');
  });

  it('regular GET stays GET', async () => {
    const batch = await extract('basic', 'src/websocket.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/health');
    expect(ep).toBeDefined();
    expect(ep!.httpMethod).toBe('GET');
    expect(ep!.framework).toBe('fastify');
  });

  it('options object without websocket key stays GET', async () => {
    const batch = await extract('basic', 'src/websocket.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/users');
    expect(ep).toBeDefined();
    expect(ep!.httpMethod).toBe('GET');
    expect(ep!.framework).toBe('fastify');
  });
});

describe('@fastify/jwt + preHandler middleware-chain detection (#110)', () => {
  it('emits middlewareChain for `{ preHandler: fastify.authenticate }` (single)', async () => {
    const batch = await extract('basic', 'src/jwt.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/protected');
    expect(ep).toBeDefined();
    expect(ep!.middlewareChain).toBeDefined();
    expect(ep!.middlewareChain![0].name).toBe('fastify.authenticate');
  });

  it('emits middlewareChain for array preHandler', async () => {
    const batch = await extract('basic', 'src/jwt.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/admin');
    expect(ep).toBeDefined();
    expect(ep!.middlewareChain).toBeDefined();
    expect(ep!.middlewareChain!.length).toBe(2);
    expect(ep!.middlewareChain![0].name).toBe('fastify.authenticate');
    expect(ep!.middlewareChain![1].name).toBe('otherCheck');
  });

  it('combines onRequest + preValidation hooks in declaration order', async () => {
    const batch = await extract('basic', 'src/jwt.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/upload');
    expect(ep).toBeDefined();
    expect(ep!.middlewareChain).toBeDefined();
    expect(ep!.middlewareChain!.length).toBe(2);
    // onRequest comes before preValidation per FASTIFY_HOOK_KEYS order.
    expect(ep!.middlewareChain![0].name).toBe('fastify.authenticate');
    expect(ep!.middlewareChain![1].name).toBe('otherCheck');
  });

  it('routes without hook keys produce no middlewareChain', async () => {
    const batch = await extract('basic', 'src/jwt.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/public');
    expect(ep).toBeDefined();
    expect(ep!.middlewareChain).toBeUndefined();
  });
});

describe('Fastify handler resolution', () => {
  it('resolves cross-file imported handler for GET /api/users', async () => {
    const ts = new TsLanguagePlugin();
    ts.registerVisitor(createFastifyVisitor());
    const handle = await ts.loadProject({ rootDir: fixturePath('basic') });
    // Must extract both files for cross-file resolution
    await ts.extractFile(handle, 'src/handlers.ts');
    const batch = await ts.extractFile(handle, 'src/server.ts');
    const ep = endpoints(batch).find(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/api/users'
    );
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// #110 — Declarative response schemas
//
// Fastify route options may carry `schema.response.<statusCode>`.
// The visitor must extract each status entry as a ResponseShape on
// the APIEndpoint, complementing the AST-observed `reply.send()`
// shapes on the handler function.
// ──────────────────────────────────────────────────────────────────────

describe('#110 — Fastify declarative response schemas', () => {
  it('emits one ResponseShape per numeric-key entry under schema.response', async () => {
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/api/users'
    );
    expect(ep).toBeDefined();
    expect(ep!.responses).toBeDefined();
    expect(ep!.responses).toHaveLength(2);
    const codes = ep!.responses!.map((r) => r.statusCode).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(codes).toEqual([200, 404]);
  });

  it('marks 4xx-and-up status codes as isErrorPath', async () => {
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/users');
    const r200 = ep!.responses!.find((r) => r.statusCode === 200);
    const r404 = ep!.responses!.find((r) => r.statusCode === 404);
    expect(r200!.isErrorPath).toBe(false);
    expect(r404!.isErrorPath).toBe(true);
  });

  it('captures the schema source text as bodyExpression', async () => {
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/users');
    const r200 = ep!.responses!.find((r) => r.statusCode === 200);
    // Source text should mention the JSON-Schema shape, not be null.
    expect(r200!.bodyExpression).toContain('array');
    expect(r200!.bodyExpression).toContain('items');
  });

  it('handles wildcard buckets (`2xx` / `4xx`) — statusCode null, isErrorPath set by bucket', async () => {
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/orders');
    expect(ep!.responses).toHaveLength(2);
    const buckets = ep!.responses!;
    // 2xx → not an error; 4xx → error. Both statusCode null.
    expect(buckets.every((r) => r.statusCode === null)).toBe(true);
    expect(buckets.filter((r) => r.isErrorPath)).toHaveLength(1);
    expect(buckets.filter((r) => !r.isErrorPath)).toHaveLength(1);
  });

  it('extracts schema from the second arg in `(path, opts, handler)` signature', async () => {
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find(
      (e) => e.httpMethod === 'POST' && e.routePattern === '/api/things'
    );
    expect(ep!.responses).toHaveLength(1);
    expect(ep!.responses![0].statusCode).toBe(201);
    expect(ep!.responses![0].isErrorPath).toBe(false);
  });

  it('routes WITHOUT schema.response have undefined responses (not [])', async () => {
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/no-schema');
    expect(ep).toBeDefined();
    expect(ep!.responses).toBeUndefined();
  });

  it('routes with schema.body but no schema.response have undefined responses', async () => {
    // Pins that we don't accidentally treat `schema.body` as a
    // response source (different field semantics).
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/body-only');
    expect(ep).toBeDefined();
    expect(ep!.responses).toBeUndefined();
  });

  it('handles mixed numeric + wildcard + default keys in one response object', async () => {
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/mixed');
    expect(ep!.responses).toHaveLength(3);
    // 200 numeric, '4xx' wildcard, 'default'.
    const status200 = ep!.responses!.find((r) => r.statusCode === 200);
    const nullCodes = ep!.responses!.filter((r) => r.statusCode === null);
    expect(status200).toBeDefined();
    expect(status200!.isErrorPath).toBe(false);
    expect(nullCodes).toHaveLength(2);
    // One of the null-status entries is the 4xx wildcard (isErrorPath=true);
    // the other is `default` (isErrorPath=false conservatively).
    expect(nullCodes.filter((r) => r.isErrorPath)).toHaveLength(1);
    expect(nullCodes.filter((r) => !r.isErrorPath)).toHaveLength(1);
  });

  it('truncates bodyExpression when the schema source exceeds the cap', async () => {
    // The `/api/long-schema` route pads its schema body with a 200-char
    // string so the full source text exceeds the 240-char cap. The
    // captured bodyExpression must end with the ellipsis sentinel so
    // consumers can detect truncation rather than silently see a
    // mid-expression cut.
    const batch = await extract('basic', 'src/schema-routes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/api/long-schema');
    expect(ep!.responses).toHaveLength(1);
    const r = ep!.responses![0];
    expect(r.bodyExpression).toBeTruthy();
    expect(r.bodyExpression!.endsWith('…')).toBe(true);
    expect(r.bodyExpression!.length).toBeLessThanOrEqual(241); // 240 + 1 ellipsis char
  });
});
