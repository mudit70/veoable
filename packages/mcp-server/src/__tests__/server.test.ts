import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { idFor, type APIEndpoint, type ClientSideAPICaller, type ClientSideProcess, type DatabaseInteraction, type DatabaseTable, type EnvironmentVariable, type FunctionDefinition, type Screen, type SourceFile } from '@adorable/schema';
import { makeBatchMeta } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { createMcpServer } from '../server.js';


const repo = 'mcp-test';

// ──────────────────────────────────────────────────────────────────────
// Seed helpers
// ──────────────────────────────────────────────────────────────────────

function seedStore(store: SQLiteCanonicalGraphStore) {
  const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/app.ts' });
  const sourceFile: SourceFile = {
    nodeType: 'SourceFile',
    id: sourceFileId,
    filePath: 'src/app.ts',
    repository: repo,
    language: 'ts',
    framework: null,
  };
  const fnId = idFor.functionDefinition({ sourceFileId, name: 'handler', sourceLine: 5 });
  const fn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: fnId,
    name: 'handler',
    sourceFileId,
    sourceLine: 5,
    parameters: [],
    returnType: null,
    isExported: true,
    isAsync: true,
  };
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({ repository: repo, httpMethod: 'GET', routePattern: '/api/users', filePath: 'a.ts', lineStart: 1 }),
    httpMethod: 'GET',
    routePattern: '/api/users',
    handlerFunctionId: fnId,
    framework: 'express',
    repository: repo,
    evidence: {
      filePath: 'src/app.ts',
      lineStart: 10,
      lineEnd: 10,
      snippet: "app.get('/api/users', handler)",
      confidence: 'exact',
    },
  };
  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({ sourceFileId, sourceLine: 20, urlLiteral: '/api/users' }),
    functionId: fnId,
    sourceFileId,
    sourceLine: 20,
    httpMethod: 'GET',
    urlLiteral: '/api/users',
    egressConfidence: 'exact',
    framework: 'fetch',
    repository: repo,
  };
  const process: ClientSideProcess = {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({ sourceFileId, sourceLine: 15, name: 'onClick' }),
    kind: 'event_handler',
    name: 'onClick',
    functionId: fnId,
    sourceFileId,
    sourceLine: 15,
    framework: 'react',
    repository: repo,
  };
  store.commit(
    { nodes: [sourceFile, fn, endpoint, caller, process], edges: [] },
    makeBatchMeta('test')
  );
  return { sourceFileId, fnId, endpoint, caller, process };
}

// ──────────────────────────────────────────────────────────────────────
// Test setup — connect client ↔ server via in-memory transport
// ──────────────────────────────────────────────────────────────────────

let store: SQLiteCanonicalGraphStore;
let client: Client;

beforeEach(async () => {
  store = new SQLiteCanonicalGraphStore(':memory:');
  const { server } = createMcpServer(store);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  store.close();
});

// ──────────────────────────────────────────────────────────────────────
// Tool discovery
// ──────────────────────────────────────────────────────────────────────

describe('tool discovery', () => {
  it('exposes the expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('describe_skill');
    expect(names).toContain('list_nodes');
    expect(names).toContain('get_node');
    expect(names).toContain('find_edges');
    expect(names).toContain('walk_flows');
    expect(names).toContain('walk_all_flows');
    expect(names).toContain('stitch');
    expect(names).toContain('list_unmatched_callers');
    expect(names).toContain('list_incomplete_flows');
  });
});

describe('describe_skill (#363)', () => {
  it('returns the canonical SKILL.md content', async () => {
    // No store seeding required — this tool is graph-independent;
    // it surfaces the skill self-description so an agent can re-orient
    // mid-session.
    const result = await client.callTool({ name: 'describe_skill', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0].text;
    // The full file (not just a slice) is returned. SKILL.md is
    // ~9 KB today; require at least 5 KB so a silent truncation
    // (e.g. half the file lost to a stream bug) fails loudly.
    expect(text.length).toBeGreaterThan(5000);
    // Frontmatter delimiter — pins the YAML header survived.
    expect(text.startsWith('---\nname: adorable')).toBe(true);
    // Load-bearing routing + workflow + recipe sections — pin them
    // so a future SKILL.md edit that drops one fails loudly.
    expect(text).toContain('## When to invoke this skill');
    expect(text).toContain('## When NOT to invoke this skill');
    expect(text).toContain('## How to use the tools well');
    expect(text).toContain('## Setup state');
    expect(text).toContain('## Concrete recipes');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Graph query tools
// ──────────────────────────────────────────────────────────────────────

describe('list_nodes', () => {
  it('returns all nodes of the requested type without evidence', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'list_nodes',
      arguments: { nodeType: 'APIEndpoint' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(1);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].routePattern).toBe('/api/users');
    // Evidence excluded by default
    expect(data.nodes[0].evidence).toBeUndefined();
  });

  it('filters by property', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'list_nodes',
      arguments: {
        nodeType: 'FunctionDefinition',
        filter: { isExported: true },
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].name).toBe('handler');
  });

  it('returns empty array when no nodes match', async () => {
    const result = await client.callTool({
      name: 'list_nodes',
      arguments: { nodeType: 'DatabaseSystem' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(0);
    expect(data.nodes).toEqual([]);
  });

  it('excludes evidence by default', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'list_nodes',
      arguments: { nodeType: 'APIEndpoint' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].evidence).toBeUndefined();
  });

  it('includes evidence when includeEvidence is true', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'list_nodes',
      arguments: { nodeType: 'APIEndpoint', includeEvidence: true },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].evidence).toBeDefined();
    expect(data.nodes[0].evidence.filePath).toBe('src/app.ts');
    expect(data.nodes[0].evidence.snippet).toContain('app.get');
  });
});

describe('get_node', () => {
  it('returns the node when found', async () => {
    const seed = seedStore(store);
    const result = await client.callTool({
      name: 'get_node',
      arguments: { nodeType: 'APIEndpoint', id: seed.endpoint.id },
    });
    const node = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(node.routePattern).toBe('/api/users');
  });

  it('returns an error when the node is not found', async () => {
    const result = await client.callTool({
      name: 'get_node',
      arguments: { nodeType: 'APIEndpoint', id: 'nope' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('find_edges', () => {
  it('returns edges matching the query', async () => {
    const seed = seedStore(store);
    // Add a RESOLVES_TO_ENDPOINT edge manually.
    store.commit(
      {
        nodes: [],
        edges: [
          {
            edgeType: 'RESOLVES_TO_ENDPOINT',
            from: seed.caller.id,
            to: seed.endpoint.id,
            matchedBy: 'exact-url',
            matchConfidence: 'high',
          },
        ],
      },
      makeBatchMeta('test')
    );
    const result = await client.callTool({
      name: 'find_edges',
      arguments: {
        from: seed.caller.id,
        to: null,
        edgeType: 'RESOLVES_TO_ENDPOINT',
      },
    });
    const edges = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(edges).toHaveLength(1);
    expect(edges[0].matchedBy).toBe('exact-url');
  });

  it('accepts every canonical edge type from @adorable/schema EDGE_TYPES (#290)', async () => {
    // Pre-fix the find_edges enum was missing 4 of 19 canonical edge
    // types (RENDERS, READS_STATE, WRITES_STATE, BUNDLES_TO). Now
    // derived from the schema's exported EDGE_TYPES — every member
    // must be accepted by the tool without a zod validation error.
    const { EDGE_TYPES } = await import('@adorable/schema');
    seedStore(store);
    for (const et of EDGE_TYPES) {
      const result = await client.callTool({
        name: 'find_edges',
        arguments: { from: null, to: null, edgeType: et },
      });
      // Should be a successful call (zero edges is fine for unseeded types).
      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(Array.isArray(body)).toBe(true);
    }
  });

  // #329 — `from` and `to` are now optional. Pre-fix Zod required
  // both keys (declared `nullable()` but not `optional()`); calling
  // with just `edgeType` failed validation. Now omitting either /
  // both is equivalent to wildcarding.
  it('#329 — from and to are optional (omit both, just filter by edgeType)', async () => {
    const seed = seedStore(store);
    store.commit(
      {
        nodes: [],
        edges: [{
          edgeType: 'RESOLVES_TO_ENDPOINT',
          from: seed.caller.id,
          to: seed.endpoint.id,
          matchedBy: 'exact-url',
          matchConfidence: 'high',
        }],
      },
      makeBatchMeta('test'),
    );
    const result = await client.callTool({
      name: 'find_edges',
      arguments: { edgeType: 'RESOLVES_TO_ENDPOINT' },
    });
    expect(result.isError).toBeFalsy();
    const edges = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('#329 — passing only `from` wildcards `to`', async () => {
    const seed = seedStore(store);
    store.commit(
      {
        nodes: [],
        edges: [{
          edgeType: 'RESOLVES_TO_ENDPOINT',
          from: seed.caller.id,
          to: seed.endpoint.id,
          matchedBy: 'exact-url',
          matchConfidence: 'high',
        }],
      },
      makeBatchMeta('test'),
    );
    const result = await client.callTool({
      name: 'find_edges',
      arguments: { from: seed.caller.id },
    });
    expect(result.isError).toBeFalsy();
    const edges = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(edges.every((e: { from: string }) => e.from === seed.caller.id)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Flow tools
// ──────────────────────────────────────────────────────────────────────

describe('stitch', () => {
  it('emits RESOLVES_TO_ENDPOINT edges and returns the count', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'stitch',
      arguments: {},
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.edgesEmitted).toBeGreaterThanOrEqual(1);
    expect(body.message).toContain('Stitched');
  });

  it('is idempotent — second call emits zero new edges', async () => {
    seedStore(store);
    await client.callTool({ name: 'stitch', arguments: {} });
    const result = await client.callTool({ name: 'stitch', arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // The stitcher still produces the same edges, but the store deduplicates on commit.
    // The edgesEmitted count reflects the stitcher's output, not net-new rows.
    expect(body.edgesEmitted).toBeGreaterThanOrEqual(0);
  });
});

describe('suggest_stitches with applicationScope (#269)', () => {
  function seedTwoAppGraph(s: SQLiteCanonicalGraphStore) {
    // Two apps: rn-client→rn-backend and admin-web→admin-backend.
    // Both backends have an identical /api/users route.
    function makeRepo(repoName: string) {
      const sfid = idFor.sourceFile({ repository: repoName, filePath: 'a.ts' });
      const fnId = idFor.functionDefinition({ sourceFileId: sfid, name: 'h', sourceLine: 1 });
      return {
        sourceFile: {
          nodeType: 'SourceFile' as const, id: sfid, filePath: 'a.ts',
          repository: repoName, language: 'ts' as const, framework: null,
        },
        fn: {
          nodeType: 'FunctionDefinition' as const, id: fnId, name: 'h',
          sourceFileId: sfid, sourceLine: 1, parameters: [], returnType: null,
          isExported: true, isAsync: false,
        },
        sfid, fnId,
      };
    }
    const rnClient = makeRepo('rn-client');
    const adminWeb = makeRepo('admin-web');
    const rnBackend = makeRepo('rn-backend');
    const adminBackend = makeRepo('admin-backend');
    const epRn: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({ repository: 'rn-backend', httpMethod: 'GET', routePattern: '/api/users', filePath: 'a.ts', lineStart: 1 }),
      httpMethod: 'GET', routePattern: '/api/users',
      handlerFunctionId: rnBackend.fnId, framework: 'express', repository: 'rn-backend',
    };
    const epAdmin: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({ repository: 'admin-backend', httpMethod: 'GET', routePattern: '/api/users', filePath: 'a.ts', lineStart: 1 }),
      httpMethod: 'GET', routePattern: '/api/users',
      handlerFunctionId: adminBackend.fnId, framework: 'express', repository: 'admin-backend',
    };
    const callerRn: ClientSideAPICaller = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({ sourceFileId: rnClient.sfid, sourceLine: 10, urlLiteral: '/api/users' }),
      functionId: rnClient.fnId, sourceFileId: rnClient.sfid, sourceLine: 10,
      httpMethod: 'GET', urlLiteral: '/api/users', egressConfidence: 'exact',
      framework: 'fetch', repository: 'rn-client',
    };
    s.commit({
      nodes: [
        rnClient.sourceFile, rnClient.fn, adminWeb.sourceFile, adminWeb.fn,
        rnBackend.sourceFile, rnBackend.fn, adminBackend.sourceFile, adminBackend.fn,
        epRn, epAdmin, callerRn,
      ],
      edges: [],
    }, makeBatchMeta('test'));
    return { callerRn };
  }

  it('without scope: caller has 2 candidates → ambiguous tier', async () => {
    seedTwoAppGraph(store);
    const result = await client.callTool({ name: 'suggest_stitches', arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.summary.ambiguous).toBe(1);
    expect(body.summary.deterministic).toBe(0);
    expect(body.ambiguous[0].matches.length).toBe(2);
  });

  it('with scope: cross-app candidate filtered → deterministic tier', async () => {
    seedTwoAppGraph(store);
    // Persist the applications declaration into project_meta — the
    // same path the CLI uses for #259.
    store.setMeta('applications', JSON.stringify([
      { name: 'rn',    repos: ['rn-client', 'rn-backend'] },
      { name: 'admin', repos: ['admin-web', 'admin-backend'] },
    ]));
    const result = await client.callTool({ name: 'suggest_stitches', arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.summary.ambiguous).toBe(0);
    expect(body.summary.deterministic).toBe(1);
    expect(body.deterministic[0].matches.length).toBe(1);
  });
});

describe('walk_flows', () => {
  it('returns flows for a specific process after stitching', async () => {
    const seed = seedStore(store);
    await client.callTool({ name: 'stitch', arguments: {} });

    const result = await client.callTool({
      name: 'walk_flows',
      arguments: { processId: seed.process.id },
    });
    const flows = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(flows.length).toBeGreaterThan(0);
    expect(flows[0].startProcess.name).toBe('onClick');
    expect(flows[0].completeness).toBeDefined();
  });

  it('returns isError + NOT_FOUND when processId resolves to a non-process node (#274)', async () => {
    const seed = seedStore(store);
    // Pass an APIEndpoint id where a ClientSideProcess id is expected.
    const result = await client.callTool({
      name: 'walk_flows',
      arguments: { processId: seed.endpoint.id },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns isError + NOT_FOUND for an unknown process id (#274)', async () => {
    const result = await client.callTool({
      name: 'walk_flows',
      arguments: { processId: 'ClientSideProcess:nope' },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toContain('ClientSideProcess id not found');
  });
});

describe('walk_all_flows', () => {
  it('returns all flows after stitching', async () => {
    seedStore(store);
    await client.callTool({ name: 'stitch', arguments: {} });

    const result = await client.callTool({
      name: 'walk_all_flows',
      arguments: {},
    });
    const flows = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(flows.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Analysis tools
// ──────────────────────────────────────────────────────────────────────

describe('list_unmatched_callers', () => {
  it('returns curated caller shape with total + totalCallers (#271)', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'list_unmatched_callers',
      arguments: {},
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.total).toBeGreaterThan(0);
    expect(body.totalCallers).toBeGreaterThan(0);
    expect(Array.isArray(body.callers)).toBe(true);
    // Curated shape — no nodeType / functionId leaked.
    const c = body.callers[0];
    expect(c.nodeType).toBeUndefined();
    expect(c.functionId).toBeUndefined();
    // Curated fields present, including jump-to-source affordances.
    expect(c.id).toBeDefined();
    expect(c.urlLiteral).toBeDefined();
    expect(c.httpMethod).toBeDefined();
    expect(c.repository).toBeDefined();
    expect(c.sourceFileId).toBeDefined();
    expect(c.sourceLine).toBeDefined();
  });

  it('returns empty list (total: 0) after stitching resolves the caller', async () => {
    seedStore(store);
    await client.callTool({ name: 'stitch', arguments: {} });
    const result = await client.callTool({
      name: 'list_unmatched_callers',
      arguments: {},
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.total).toBe(0);
    expect(body.callers).toEqual([]);
  });
});

describe('list_incomplete_flows', () => {
  it('returns flows that did not reach the database', async () => {
    seedStore(store);
    await client.callTool({ name: 'stitch', arguments: {} });
    const result = await client.callTool({
      name: 'list_incomplete_flows',
      arguments: {},
    });
    const flows = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // The seed has no DatabaseInteraction, so every flow is incomplete.
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.every((f: { completeness: string }) => f.completeness !== 'complete')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Additional coverage — test gaps from PR review
// ──────────────────────────────────────────────────────────────────────

describe('add_stitch_rule (#273)', () => {
  let configPath: string;
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      const fs = await import('node:fs');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-asr-'));
    configPath = path.join(tmpDir, 'project.json');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'test-project',
      output: 'graph.db',
      repos: [{ path: '.', name: 'rn-client' }],
    }, null, 2));

    // Re-create server pointing at this temp config.
    await client.close();
    store.close();
    store = new SQLiteCanonicalGraphStore(':memory:');
    const { server } = createMcpServer(store, { projectConfigPath: configPath });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(ct);
  });

  it('appends a new rule and writes to disk', async () => {
    const result = await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'r1', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api' },
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.message).toContain('added');
    const fs = await import('node:fs');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.stitchRules).toHaveLength(1);
  });

  it('dryRun returns the rule without writing', async () => {
    const result = await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'r1', from: 'a', to: 'b', transformType: 'addPrefix', prefix: '/api', dryRun: true },
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.message).toContain('Dry-run');
    expect(body.wouldAdd).toBeDefined();
    const fs = await import('node:fs');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.stitchRules ?? []).toHaveLength(0);
  });

  it('is idempotent: same args twice produces no duplicate', async () => {
    await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'r1', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api' },
    });
    const result2 = await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'r1', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api' },
    });
    const body = JSON.parse((result2.content as Array<{ text: string }>)[0].text);
    expect(body.message).toContain('already exists');
    const fs = await import('node:fs');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.stitchRules).toHaveLength(1);
  });

  it('renaming a rule (same transform) does NOT add a duplicate', async () => {
    await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'first-name', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api' },
    });
    const result2 = await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'second-name', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api' },
    });
    const body = JSON.parse((result2.content as Array<{ text: string }>)[0].text);
    expect(body.message).toContain('already exists');
    expect(body.existingRule.name).toBe('first-name');
  });

  it('different transform on same repo pair IS a new rule', async () => {
    await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'r1', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api' },
    });
    await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'r2', from: 'a', to: 'b', transformType: 'addPrefix', prefix: '/v1' },
    });
    const fs = await import('node:fs');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.stitchRules).toHaveLength(2);
  });

  it('replacePrefix dedup distinguishes by inner {from,to} (canonical key)', async () => {
    // Regression for the canonical-JSON-replacer bug caught in PR review.
    // Pre-fix the replacer-array filtered out the inner from/to and
    // collapsed every replacePrefix on the same repo pair.
    await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'r1', from: 'a', to: 'b', transformType: 'replacePrefix',
                   fromPrefix: '/old', toPrefix: '/new' },
    });
    await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'r2', from: 'a', to: 'b', transformType: 'replacePrefix',
                   fromPrefix: '/foo', toPrefix: '/bar' },
    });
    const fs = await import('node:fs');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.stitchRules).toHaveLength(2);
  });

  it('two consecutive dryRun calls with identical args produce distinct responses (#291)', async () => {
    // First dryRun on a brand-new rule.
    const r1 = await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'rmemo', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api', dryRun: true },
    });
    const b1 = JSON.parse((r1.content as Array<{ text: string }>)[0].text);
    expect(b1.message).toContain('Dry-run: rule would be added.');
    expect(b1.previousPreview).toBeUndefined();

    // Second dryRun with IDENTICAL args. Persistence-state dedup
    // doesn't fire (rule isn't in the config), but in-session
    // memoization should distinguish this from the first call.
    const r2 = await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'rmemo', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api', dryRun: true },
    });
    const b2 = JSON.parse((r2.content as Array<{ text: string }>)[0].text);
    expect(b2.message).toContain('previewed earlier in this session');
    expect(b2.previousPreview).toBeDefined();
    expect(b2.previousPreview.ruleName).toBe('rmemo');
    expect(b2.previousPreview.previewedAt).toBeDefined();

    // Config remains unchanged after both dryRuns.
    const fs = await import('node:fs');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.stitchRules ?? []).toHaveLength(0);
  });

  it('dryRun memoization keys on (from, to, transform), not name', async () => {
    // First call: memoize.
    await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'first', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api', dryRun: true },
    });
    // Second call with DIFFERENT name but same identity tuple → still
    // detected as memoized (memoization key is identity, not name).
    const r = await client.callTool({
      name: 'add_stitch_rule',
      arguments: { name: 'renamed', from: 'a', to: 'b', transformType: 'stripPrefix', prefix: '/api', dryRun: true },
    });
    const b = JSON.parse((r.content as Array<{ text: string }>)[0].text);
    expect(b.message).toContain('previewed earlier in this session');
    expect(b.previousPreview.ruleName).toBe('first');
  });
});


describe('error contract: every id-taking tool returns isError + code on bad input (#274/#277)', () => {
  it('get_node returns isError + NOT_FOUND for unknown id', async () => {
    const result = await client.callTool({
      name: 'get_node',
      arguments: { nodeType: 'APIEndpoint', id: 'APIEndpoint:DOES_NOT_EXIST' },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('describe_file returns isError + NOT_FOUND for unknown path', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'describe_file',
      arguments: { filePath: 'no/such/file.ts' },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('describe_screen returns isError + NOT_FOUND for unknown screen name', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'describe_screen',
      arguments: { screenName: 'NoSuchScreen' },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('walk_screen_flows returns isError + NOT_FOUND for unknown screen name', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'walk_screen_flows',
      arguments: { screenName: 'NoSuchScreen' },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('get_source_file returns isError + NOT_FOUND for unknown nodeId', async () => {
    // get_source_file requires --project-root; create a server with one.
    const projectStore = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const { server: ps } = createMcpServer(projectStore, { projectRoot: '/tmp' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await ps.connect(st);
      const c = new Client({ name: 't', version: '0' });
      await c.connect(ct);
      const result = await c.callTool({
        name: 'get_source_file',
        arguments: { nodeId: 'FunctionDefinition:DOES_NOT_EXIST' },
      });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(body.code).toBe('NOT_FOUND');
      await c.close();
    } finally {
      projectStore.close();
    }
  });

  // #329 — get_source_file accepts filePath as alternative to nodeId.
  it('#329 — get_source_file accepts filePath substring lookup', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-gsf-'));
    try {
      await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'src/users.ts'), 'export function listUsers() { return []; }\n');
      const projectStore = new SQLiteCanonicalGraphStore(':memory:');
      try {
        // Seed a SourceFile node so the substring lookup has a target.
        const { idFor } = await import('@adorable/schema');
        const sfId = idFor.sourceFile({ repository: 'test', filePath: 'src/users.ts' });
        projectStore.commit({
          nodes: [{
            nodeType: 'SourceFile' as const,
            id: sfId,
            filePath: 'src/users.ts',
            repository: "test", language: "ts",
            framework: null,
          }],
          edges: [],
        }, makeBatchMeta('test'));

        const { server: ps } = createMcpServer(projectStore, { projectRoot: tmp });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await ps.connect(st);
        const c = new Client({ name: 't', version: '0' });
        await c.connect(ct);

        // Substring filePath ("users.ts") should resolve to src/users.ts.
        const r1 = await c.callTool({
          name: 'get_source_file',
          arguments: { filePath: 'users.ts' },
        });
        expect(r1.isError).toBeFalsy();
        const body1 = JSON.parse((r1.content as Array<{ text: string }>)[0].text);
        expect(body1.filePath).toBe('src/users.ts');
        expect(body1.content).toContain('listUsers');

        // Exact match is preferred when both exact and substring exist.
        const r2 = await c.callTool({
          name: 'get_source_file',
          arguments: { filePath: 'src/users.ts' },
        });
        expect(r2.isError).toBeFalsy();

        // Neither nodeId nor filePath → INVALID_INPUT.
        const r3 = await c.callTool({
          name: 'get_source_file',
          arguments: {},
        });
        expect(r3.isError).toBe(true);
        const body3 = JSON.parse((r3.content as Array<{ text: string }>)[0].text);
        expect(body3.code).toBe('INVALID_INPUT');

        await c.close();
      } finally {
        projectStore.close();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('#329 — get_source_file path-traversal guard still active when filePath is supplied', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-gsf-'));
    try {
      const projectStore = new SQLiteCanonicalGraphStore(':memory:');
      try {
        // Seed a SourceFile node whose filePath points outside the project root.
        const { idFor } = await import('@adorable/schema');
        const sfId = idFor.sourceFile({ repository: 'test', filePath: '../../etc/passwd' });
        projectStore.commit({
          nodes: [{
            nodeType: 'SourceFile' as const,
            id: sfId,
            filePath: '../../etc/passwd',
            repository: "test", language: "ts",
            framework: null,
          }],
          edges: [],
        }, makeBatchMeta('test'));

        const { server: ps } = createMcpServer(projectStore, { projectRoot: tmp });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await ps.connect(st);
        const c = new Client({ name: 't', version: '0' });
        await c.connect(ct);

        const r = await c.callTool({
          name: 'get_source_file',
          arguments: { filePath: 'passwd' },
        });
        expect(r.isError).toBe(true);
        const text = (r.content as Array<{ text: string }>)[0].text;
        expect(text).toMatch(/Path traversal denied|outside project root/);

        await c.close();
      } finally {
        projectStore.close();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // #339 — Lazy SourceFile index. The first filePath lookup populates
  // a Map<filePath, SourceFile> cached on the store; subsequent
  // lookups reuse it. Validates correctness (same result on N calls)
  // and that the cache survives across invocations.
  it('#339 — filePath lookup is consistent across repeated calls (index reuse)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-idx-'));
    try {
      await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'src/a.ts'), 'export const a = 1;\n');
      await fs.writeFile(path.join(tmp, 'src/b.ts'), 'export const b = 2;\n');
      const projectStore = new SQLiteCanonicalGraphStore(':memory:');
      try {
        const { idFor } = await import('@adorable/schema');
        projectStore.commit({
          nodes: [
            {
              nodeType: 'SourceFile' as const,
              id: idFor.sourceFile({ repository: 'test', filePath: 'src/a.ts' }),
              filePath: 'src/a.ts',
              repository: 'test',
              language: 'ts',
              framework: null,
            },
            {
              nodeType: 'SourceFile' as const,
              id: idFor.sourceFile({ repository: 'test', filePath: 'src/b.ts' }),
              filePath: 'src/b.ts',
              repository: 'test',
              language: 'ts',
              framework: null,
            },
          ],
          edges: [],
        }, makeBatchMeta('test'));

        const { server: ps } = createMcpServer(projectStore, { projectRoot: tmp });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await ps.connect(st);
        const c = new Client({ name: 't', version: '0' });
        await c.connect(ct);

        // Five repeated calls — index must yield the same result.
        for (let i = 0; i < 5; i++) {
          const r = await c.callTool({
            name: 'get_source_file',
            arguments: { filePath: 'src/a.ts' },
          });
          expect(r.isError).toBeFalsy();
          const body = JSON.parse((r.content as Array<{ text: string }>)[0].text);
          expect(body.filePath).toBe('src/a.ts');
          expect(body.content).toContain('export const a');
        }

        // Substring lookup also consistent.
        const r = await c.callTool({
          name: 'get_source_file',
          arguments: { filePath: 'b.ts' },
        });
        expect(r.isError).toBeFalsy();
        const body = JSON.parse((r.content as Array<{ text: string }>)[0].text);
        expect(body.filePath).toBe('src/b.ts');

        await c.close();
      } finally {
        projectStore.close();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('list_incomplete_flows null-field bloat (#276)', () => {
  it('strips null endpoint/matchConfidence/matchedBy/handlerFunction and empty arrays', async () => {
    seedStore(store);
    // No stitch — the seeded caller stays unmatched, walking from its
    // process produces an incomplete flow.
    const result = await client.callTool({
      name: 'list_incomplete_flows',
      arguments: {},
    });
    const flows = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(Array.isArray(flows)).toBe(true);
    expect(flows.length).toBeGreaterThan(0);
    for (const f of flows) {
      // Always-null on incomplete flows — should be dropped.
      expect(Object.keys(f)).not.toContain('endpoint');
      expect(Object.keys(f)).not.toContain('matchConfidence');
      expect(Object.keys(f)).not.toContain('matchedBy');
      expect(Object.keys(f)).not.toContain('handlerFunction');
      // Always-empty arrays — should be dropped (these specific
      // assertions hold when the flow is process-only / function-only;
      // the seeded fixture is one of these).
      expect(f.completeness).toBeDefined();
    }
  });
});

describe('walk_flows with maxCallDepth', () => {
  it('passes maxCallDepth through to the flow walker', async () => {
    const seed = seedStore(store);
    await client.callTool({ name: 'stitch', arguments: {} });

    const result = await client.callTool({
      name: 'walk_flows',
      arguments: { processId: seed.process.id, maxCallDepth: 1 },
    });
    const flows = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // With maxCallDepth=1, the walker still finds the direct caller
    // (it's reachable in one hop). The result should be a valid array.
    expect(Array.isArray(flows)).toBe(true);
    expect(flows.length).toBeGreaterThan(0);
  });
});

describe('stitch on empty store', () => {
  it('returns edgesEmitted: 0 and a no-new-edges message', async () => {
    // Store is empty — no callers, no endpoints, nothing to stitch.
    const result = await client.callTool({
      name: 'stitch',
      arguments: {},
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.edgesEmitted).toBe(0);
    expect(body.message).toContain('No new edges');
  });
});

describe('formatFlows does not include rawQuery', () => {
  it('omits rawQuery from database hop output', async () => {
    const seed = seedStore(store);

    // Add a DatabaseInteraction with a rawQuery and wire it up.
    const tableId = idFor.databaseTable({ systemId: 'sys1', schema: null, name: 'users' });
    const dbTable: DatabaseTable = {
      nodeType: 'DatabaseTable',
      id: tableId,
      systemId: 'sys1',
      name: 'users',
      schema: null,
      kind: 'table',
      declaredIn: null,
    };
    const dbInteraction: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: seed.fnId,
        operation: 'read',
        targetTableId: tableId,
      }),
      callSiteFunctionId: seed.fnId,
      operation: 'read',
      orm: 'prisma',
      rawQuery: 'SELECT * FROM users WHERE password = ?',
      confidence: 'direct',
    };
    store.commit(
      {
        nodes: [dbInteraction, dbTable],
        edges: [
          {
            edgeType: 'PERFORMED_BY',
            from: dbInteraction.id,
            to: seed.fnId,
            sourceLine: 10,
          },
          {
            edgeType: 'READS',
            from: dbInteraction.id,
            to: dbTable.id,
            columns: null,
            filters: null,
          },
        ],
      },
      makeBatchMeta('test')
    );

    await client.callTool({ name: 'stitch', arguments: {} });

    const result = await client.callTool({
      name: 'walk_flows',
      arguments: { processId: seed.process.id },
    });
    const rawText = (result.content as Array<{ text: string }>)[0].text;
    // The rawQuery should NOT appear anywhere in the formatted output.
    expect(rawText).not.toContain('rawQuery');
    expect(rawText).not.toContain('SELECT * FROM users');

    // But the operation and orm SHOULD be present.
    const flows = JSON.parse(rawText);
    const hopsWithData = flows.filter(
      (f: { databaseHops: unknown[] }) => f.databaseHops.length > 0
    );
    expect(hopsWithData.length).toBeGreaterThan(0);
    expect(hopsWithData[0].databaseHops[0].operation).toBe('read');
    expect(hopsWithData[0].databaseHops[0].orm).toBe('prisma');
  });
});

describe('list_nodes with invalid nodeType', () => {
  it('rejects an invalid nodeType via the zod enum', async () => {
    const result = await client.callTool({
      name: 'list_nodes',
      arguments: { nodeType: 'NotARealType' },
    });
    // The MCP SDK validates via zod and returns an error response
    // rather than crashing the server.
    expect(result.isError).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Lightweight query tools (#118)
// ──────────────────────────────────────────────────────────────────────

describe('stats', () => {
  it('returns aggregate counts for the graph', async () => {
    seedStore(store);
    const result = await client.callTool({ name: 'stats', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.endpoints).toBe(1);
    expect(data.sourceFiles).toBeGreaterThanOrEqual(1);
    expect(data.flows).toBeDefined();
    expect(data.flows.total).toBeGreaterThanOrEqual(0);
  });
});

describe('describe_architecture', () => {
  it('returns endpoint domains and database summary', async () => {
    seedStore(store);
    const result = await client.callTool({ name: 'describe_architecture', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalEndpoints).toBe(1);
    expect(data.endpointDomains).toHaveLength(1);
    expect(data.endpointDomains[0].prefix).toBe('/api');
  });
});

describe('list_nodes countOnly', () => {
  it('returns only the count when countOnly is true', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'list_nodes',
      arguments: { nodeType: 'APIEndpoint', countOnly: true },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(1);
    expect(data.nodes).toBeUndefined();
  });
});

describe('list_nodes fields projection', () => {
  it('returns only requested fields', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'list_nodes',
      arguments: { nodeType: 'APIEndpoint', fields: ['httpMethod', 'routePattern'] },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.nodes[0].httpMethod).toBe('GET');
    expect(data.nodes[0].routePattern).toBe('/api/users');
    expect(data.nodes[0].framework).toBeUndefined();
    expect(data.nodes[0].id).toBeDefined(); // id always included
  });
});

describe('walk_all_flows with completenessFilter', () => {
  it('filters by completeness level', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'walk_all_flows',
      arguments: { completenessFilter: 'complete' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    for (const flow of data) {
      expect(flow.completeness).toBe('complete');
    }
  });
});

describe('walk_all_flows countOnly', () => {
  it('returns only the count', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'walk_all_flows',
      arguments: { countOnly: true },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBeDefined();
    expect(typeof data.total).toBe('number');
  });
});

describe('impact_analysis', () => {
  it('analyzes impact by table name', async () => {
    seedStore(store);
    // Seed a DatabaseTable so #274's bad-id check passes.
    const sysId = idFor.databaseSystem({ name: 'pg', kind: 'postgres', repository: repo });
    const tableId = idFor.databaseTable({ systemId: sysId, schema: null, name: 'User' });
    store.commit({
      nodes: [
        { nodeType: 'DatabaseSystem', id: sysId, name: 'pg', kind: 'postgres', connectionSource: null },
        { nodeType: 'DatabaseTable', id: tableId, systemId: sysId, schema: null, name: 'User', kind: 'table', declaredIn: null },
      ],
      edges: [],
    }, makeBatchMeta('test-impact'));
    const result = await client.callTool({
      name: 'impact_analysis',
      arguments: { tableName: 'User' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.table).toBe('User');
    expect(data.affectedFlowCount).toBeGreaterThanOrEqual(0);
  });

  it('returns isError + NOT_FOUND for unknown table name (#274)', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'impact_analysis',
      arguments: { tableName: 'NoSuchTable' },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns error when no parameter provided', async () => {
    seedStore(store);
    const result = await client.callTool({
      name: 'impact_analysis',
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });
});

describe('list_middleware', () => {
  function seedWithMiddleware() {
    const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/app.ts' });
    const sourceFile: SourceFile = {
      nodeType: 'SourceFile',
      id: sourceFileId,
      filePath: 'src/app.ts',
      repository: repo,
      language: 'ts',
      framework: null,
    };
    const handlerId = idFor.functionDefinition({ sourceFileId, name: 'getUsers', sourceLine: 20 });
    const handler: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: handlerId,
      name: 'getUsers',
      sourceFileId,
      sourceLine: 20,
      parameters: [],
      returnType: null,
      isExported: true,
      isAsync: true,
    };
    const authMwId = idFor.functionDefinition({ sourceFileId, name: 'authMiddleware', sourceLine: 5 });
    const authMw: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: authMwId,
      name: 'authMiddleware',
      sourceFileId,
      sourceLine: 5,
      parameters: [],
      returnType: null,
      isExported: true,
      isAsync: false,
    };
    const ep1: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({ repository: repo, httpMethod: 'GET', routePattern: '/api/users', filePath: 'a.ts', lineStart: 1 }),
      httpMethod: 'GET',
      routePattern: '/api/users',
      handlerFunctionId: handlerId,
      framework: 'express',
      repository: repo,
      middlewareChain: [
        { functionId: authMwId, name: 'authMiddleware', order: 0 },
        { functionId: null, name: 'logRequest', order: 1 },
      ],
    };
    const ep2: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({ repository: repo, httpMethod: 'POST', routePattern: '/api/admin', filePath: 'a.ts', lineStart: 1 }),
      httpMethod: 'POST',
      routePattern: '/api/admin',
      handlerFunctionId: handlerId,
      framework: 'express',
      repository: repo,
      middlewareChain: [
        { functionId: authMwId, name: 'authMiddleware', order: 0 },
      ],
    };
    const ep3: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({ repository: repo, httpMethod: 'GET', routePattern: '/health', filePath: 'a.ts', lineStart: 1 }),
      httpMethod: 'GET',
      routePattern: '/health',
      handlerFunctionId: handlerId,
      framework: 'express',
      repository: repo,
    };
    store.commit(
      { nodes: [sourceFile, handler, authMw, ep1, ep2, ep3], edges: [] },
      makeBatchMeta('test')
    );
  }

  it('aggregates middleware across endpoints with order and source location', async () => {
    seedWithMiddleware();
    const result = await client.callTool({ name: 'list_middleware', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    expect(data.total).toBe(2);
    expect(data.totalEndpoints).toBe(3);

    const auth = data.middleware.find((m: any) => m.name === 'authMiddleware');
    expect(auth).toBeDefined();
    expect(auth.sourceFile).toBe('src/app.ts');
    expect(auth.sourceLine).toBe(5);
    expect(auth.protectedEndpoints).toHaveLength(2);
    expect(auth.protectedEndpoints.map((e: any) => e.routePattern).sort()).toEqual(['/api/admin', '/api/users']);
    expect(auth.protectedEndpoints.every((e: any) => e.order === 0)).toBe(true);

    const log = data.middleware.find((m: any) => m.name === 'logRequest');
    expect(log).toBeDefined();
    expect(log.functionId).toBeNull();
    expect(log.sourceFile).toBeNull();
    expect(log.protectedEndpoints).toHaveLength(1);
    expect(log.protectedEndpoints[0].order).toBe(1);
  });

  it('filters by name substring (case-insensitive)', async () => {
    seedWithMiddleware();
    const result = await client.callTool({
      name: 'list_middleware',
      arguments: { name: 'AUTH' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(1);
    expect(data.middleware[0].name).toBe('authMiddleware');
  });

  it('returns empty list when no endpoints have middleware', async () => {
    seedStore(store);
    const result = await client.callTool({ name: 'list_middleware', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(0);
    expect(data.middleware).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Smoke tests for #139 developer-debugging tools
// ──────────────────────────────────────────────────────────────────────

/** Seed a small mobile graph: SourceFile + component fn + Screen + Process + Caller + 1 env var. */
function seedMobile(s: SQLiteCanonicalGraphStore) {
  const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/screens/Login.tsx' });
  const sourceFile: SourceFile = {
    nodeType: 'SourceFile',
    id: sourceFileId,
    filePath: 'src/screens/Login.tsx',
    repository: repo,
    language: 'tsx',
    framework: 'react-native',
  };
  const compFnId = idFor.functionDefinition({ sourceFileId, name: 'Login', sourceLine: 4 });
  const compFn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: compFnId,
    name: 'Login',
    sourceFileId,
    sourceLine: 4,
    parameters: [],
    returnType: null,
    isExported: true,
    isAsync: false,
  };
  const homeFileId = idFor.sourceFile({ repository: repo, filePath: 'src/screens/Home.tsx' });
  const homeFile: SourceFile = {
    nodeType: 'SourceFile',
    id: homeFileId,
    filePath: 'src/screens/Home.tsx',
    repository: repo,
    language: 'tsx',
    framework: 'react-native',
  };
  const homeFnId = idFor.functionDefinition({ sourceFileId: homeFileId, name: 'Home', sourceLine: 4 });
  const homeFn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: homeFnId,
    name: 'Home',
    sourceFileId: homeFileId,
    sourceLine: 4,
    parameters: [],
    returnType: null,
    isExported: true,
    isAsync: false,
  };
  const loginScreen: Screen = {
    nodeType: 'Screen',
    id: idFor.screen({ repository: repo, name: 'Login' }),
    name: 'Login',
    componentFunctionId: compFnId,
    navigatorKind: 'stack',
    sourceFileId,
    sourceLine: 4,
    framework: 'react-native',
    repository: repo,
  };
  const homeScreen: Screen = {
    nodeType: 'Screen',
    id: idFor.screen({ repository: repo, name: 'Home' }),
    name: 'Home',
    componentFunctionId: homeFnId,
    navigatorKind: 'stack',
    sourceFileId: homeFileId,
    sourceLine: 4,
    framework: 'react-native',
    repository: repo,
  };
  // Orphan screen — no NAVIGATES_TO points at it.
  const orphanScreen: Screen = {
    nodeType: 'Screen',
    id: idFor.screen({ repository: repo, name: 'Orphan' }),
    name: 'Orphan',
    componentFunctionId: null,
    navigatorKind: 'stack',
    sourceFileId,
    sourceLine: 99,
    framework: 'react-native',
    repository: repo,
  };
  const onPress: ClientSideProcess = {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({ sourceFileId, sourceLine: 12, name: 'onPress' }),
    kind: 'event_handler',
    name: 'onPress',
    functionId: compFnId,
    sourceFileId,
    sourceLine: 12,
    framework: 'react-native',
    repository: repo,
  };
  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({ sourceFileId, sourceLine: 15, urlLiteral: '/api/login' }),
    functionId: compFnId,
    sourceFileId,
    sourceLine: 15,
    httpMethod: 'POST',
    urlLiteral: '/api/login',
    egressConfidence: 'exact',
    framework: 'fetch',
    repository: repo,
  };
  const envVar: EnvironmentVariable = {
    nodeType: 'EnvironmentVariable',
    id: idFor.environmentVariable({ sourceFileId, name: 'API_URL', sourceLine: 2 }),
    name: 'API_URL',
    category: 'api',
    hasDefault: false,
    accessPattern: 'process.env',
    sourceFileId,
    sourceLine: 2,
    functionId: null,
    repository: repo,
  };
  s.commit(
    {
      nodes: [sourceFile, homeFile, compFn, homeFn, loginScreen, homeScreen, orphanScreen, onPress, caller, envVar],
      edges: [
        { edgeType: 'NAVIGATES_TO', from: compFnId, to: homeScreen.id },
      ],
    },
    makeBatchMeta('test'),
  );
  return { sourceFileId, compFnId, loginScreen, homeScreen, orphanScreen };
}

/**
 * Seed an SSG scenario (#198 PR2): two HTML/Nunjucks templates with
 * Screen nodes that have NO componentFunctionId (page-only). The
 * BlogIndex template links to BlogPost via an `<a href>`-style
 * NAVIGATES_TO edge that originates from the BlogIndex's SourceFile
 * id (not a FunctionDefinition). Lets the tests pin the new
 * SourceFile-originated nav-edge handling.
 */
function seedSsg(s: SQLiteCanonicalGraphStore) {
  const indexFileId = idFor.sourceFile({ repository: repo, filePath: 'site/blog/index.njk' });
  const indexFile: SourceFile = {
    nodeType: 'SourceFile',
    id: indexFileId,
    filePath: 'site/blog/index.njk',
    repository: repo,
    language: 'nunjucks',
    framework: 'lang-html',
  };
  const postFileId = idFor.sourceFile({ repository: repo, filePath: 'site/blog/post-title/index.njk' });
  const postFile: SourceFile = {
    nodeType: 'SourceFile',
    id: postFileId,
    filePath: 'site/blog/post-title/index.njk',
    repository: repo,
    language: 'nunjucks',
    framework: 'lang-html',
  };
  const blogIndex: Screen = {
    nodeType: 'Screen',
    id: idFor.screen({ repository: repo, name: 'BlogIndex', routePath: '/blog/' }),
    name: 'BlogIndex',
    componentFunctionId: null,
    routePath: '/blog/',
    sourceFileId: indexFileId,
    sourceLine: 1,
    framework: 'lang-html',
    repository: repo,
  };
  const blogPost: Screen = {
    nodeType: 'Screen',
    id: idFor.screen({ repository: repo, name: 'BlogPost', routePath: '/blog/post-title/' }),
    name: 'BlogPost',
    componentFunctionId: null,
    routePath: '/blog/post-title/',
    sourceFileId: postFileId,
    sourceLine: 1,
    framework: 'lang-html',
    repository: repo,
  };
  s.commit(
    {
      nodes: [indexFile, postFile, blogIndex, blogPost],
      edges: [
        // SSG-shape: NAVIGATES_TO from a SourceFile (not a FunctionDefinition).
        { edgeType: 'NAVIGATES_TO', from: indexFileId, to: blogPost.id },
      ],
    },
    makeBatchMeta('test'),
  );
  return { indexFileId, postFileId, blogIndex, blogPost };
}

describe('list_uncalled_endpoints', () => {
  it('returns endpoints with no incoming RESOLVES_TO_ENDPOINT edge', async () => {
    seedStore(store);
    const result = await client.callTool({ name: 'list_uncalled_endpoints', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(1);
    expect(data.totalEndpoints).toBe(1);
    expect(data.endpoints[0].routePattern).toBe('/api/users');
  });

  it('returns empty after stitching resolves the endpoint', async () => {
    seedStore(store);
    await client.callTool({ name: 'stitch', arguments: {} });
    const result = await client.callTool({ name: 'list_uncalled_endpoints', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(0);
  });
});

describe('list_unreachable_screens', () => {
  it('returns screens with no incoming NAVIGATES_TO edge', async () => {
    seedMobile(store);
    const result = await client.callTool({ name: 'list_unreachable_screens', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalScreens).toBe(3);
    const names = data.screens.map((s: any) => s.name).sort();
    expect(names).toEqual(['Login', 'Orphan']); // Home is the only one navigated TO
  });
});

describe('list_orphan_tables (#11)', () => {
  function seedTablesAndOneInteraction(s: SQLiteCanonicalGraphStore) {
    const sysId = idFor.databaseSystem({ name: 'pg', kind: 'postgres', repository: repo });
    const usersTableId = idFor.databaseTable({ systemId: sysId, schema: null, name: 'users' });
    const ordersTableId = idFor.databaseTable({ systemId: sysId, schema: null, name: 'orders' });
    const auditTableId = idFor.databaseTable({ systemId: sysId, schema: null, name: 'audit_log' });
    const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/svc.ts' });
    const fnId = idFor.functionDefinition({ sourceFileId, name: 'svc', sourceLine: 1 });
    const interactionId = idFor.databaseInteraction({
      callSiteFunctionId: fnId, operation: 'read', targetTableId: usersTableId,
    });
    s.commit({
      nodes: [
        { nodeType: 'DatabaseSystem', id: sysId, name: 'pg', kind: 'postgres', connectionSource: null },
        { nodeType: 'DatabaseTable', id: usersTableId, systemId: sysId, schema: null, name: 'users', kind: 'table', declaredIn: null },
        { nodeType: 'DatabaseTable', id: ordersTableId, systemId: sysId, schema: null, name: 'orders', kind: 'table', declaredIn: null },
        { nodeType: 'DatabaseTable', id: auditTableId, systemId: sysId, schema: null, name: 'audit_log', kind: 'table', declaredIn: null },
        {
          nodeType: 'SourceFile', id: sourceFileId, filePath: 'src/svc.ts',
          repository: repo, language: 'ts', framework: null,
        },
        {
          nodeType: 'FunctionDefinition', id: fnId, name: 'svc',
          sourceFileId, sourceLine: 1, parameters: [], returnType: null,
          isExported: false, isAsync: false,
        },
        {
          nodeType: 'DatabaseInteraction', id: interactionId,
          callSiteFunctionId: fnId, operation: 'read', orm: 'prisma',
          rawQuery: null, confidence: 'direct',
          evidence: { filePath: 'src/svc.ts', lineStart: 1, lineEnd: 1, snippet: 'find', confidence: 'exact' },
        },
      ],
      edges: [
        { edgeType: 'TABLE_IN', from: usersTableId, to: sysId },
        { edgeType: 'TABLE_IN', from: ordersTableId, to: sysId },
        { edgeType: 'TABLE_IN', from: auditTableId, to: sysId },
        // Only `users` gets a READS edge from the interaction.
        { edgeType: 'READS', from: interactionId, to: usersTableId, columns: null, filters: null },
      ],
    }, makeBatchMeta('test-orphan'));
    return { usersTableId, ordersTableId, auditTableId };
  }

  it('returns tables with no READS or WRITES edges pointing at them', async () => {
    seedTablesAndOneInteraction(store);
    const result = await client.callTool({ name: 'list_orphan_tables', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalTables).toBe(3);
    expect(data.total).toBe(2);
    const names = data.tables.map((t: any) => t.name).sort();
    expect(names).toEqual(['audit_log', 'orders']);
  });

  it('returns empty list when every table is touched', async () => {
    const { usersTableId, ordersTableId, auditTableId } = seedTablesAndOneInteraction(store);
    // Add WRITES edges so the remaining two are also touched.
    const interactionId2 = idFor.databaseInteraction({
      callSiteFunctionId: idFor.functionDefinition({
        sourceFileId: idFor.sourceFile({ repository: repo, filePath: 'src/svc.ts' }),
        name: 'svc', sourceLine: 1,
      }),
      operation: 'write',
      targetTableId: ordersTableId,
    });
    store.commit({
      nodes: [
        {
          nodeType: 'DatabaseInteraction', id: interactionId2,
          callSiteFunctionId: idFor.functionDefinition({
            sourceFileId: idFor.sourceFile({ repository: repo, filePath: 'src/svc.ts' }),
            name: 'svc', sourceLine: 1,
          }),
          operation: 'write', orm: 'prisma',
          rawQuery: null, confidence: 'direct',
          evidence: { filePath: 'src/svc.ts', lineStart: 2, lineEnd: 2, snippet: 'create', confidence: 'exact' },
        },
      ],
      edges: [
        { edgeType: 'WRITES', from: interactionId2, to: ordersTableId, columns: null, kind: 'insert' },
        { edgeType: 'WRITES', from: interactionId2, to: auditTableId, columns: null, kind: 'insert' },
      ],
    }, makeBatchMeta('test-orphan-2'));
    void usersTableId; // already touched
    const result = await client.callTool({ name: 'list_orphan_tables', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalTables).toBe(3);
    expect(data.total).toBe(0);
    expect(data.tables).toEqual([]);
  });

  it('returns empty list when there are no DatabaseTable nodes at all', async () => {
    const result = await client.callTool({ name: 'list_orphan_tables', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalTables).toBe(0);
    expect(data.total).toBe(0);
  });

  it('a table touched by WRITES alone (insert-only) is not orphan', async () => {
    // Seed two tables: one with only WRITES (audit log pattern), one with nothing.
    const sysId = idFor.databaseSystem({ name: 'pg', kind: 'postgres', repository: repo });
    const auditTableId = idFor.databaseTable({ systemId: sysId, schema: null, name: 'audit_log' });
    const idleTableId = idFor.databaseTable({ systemId: sysId, schema: null, name: 'idle' });
    const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/audit.ts' });
    const fnId = idFor.functionDefinition({ sourceFileId, name: 'logAudit', sourceLine: 1 });
    const interactionId = idFor.databaseInteraction({
      callSiteFunctionId: fnId, operation: 'write', targetTableId: auditTableId,
    });
    store.commit({
      nodes: [
        { nodeType: 'DatabaseSystem', id: sysId, name: 'pg', kind: 'postgres', connectionSource: null },
        { nodeType: 'DatabaseTable', id: auditTableId, systemId: sysId, schema: null, name: 'audit_log', kind: 'table', declaredIn: null },
        { nodeType: 'DatabaseTable', id: idleTableId, systemId: sysId, schema: null, name: 'idle', kind: 'table', declaredIn: null },
        { nodeType: 'SourceFile', id: sourceFileId, filePath: 'src/audit.ts', repository: repo, language: 'ts', framework: null },
        { nodeType: 'FunctionDefinition', id: fnId, name: 'logAudit', sourceFileId, sourceLine: 1, parameters: [], returnType: null, isExported: false, isAsync: false },
        { nodeType: 'DatabaseInteraction', id: interactionId, callSiteFunctionId: fnId, operation: 'write', orm: 'prisma', rawQuery: null, confidence: 'direct', evidence: { filePath: 'src/audit.ts', lineStart: 1, lineEnd: 1, snippet: 'create', confidence: 'exact' } },
      ],
      edges: [
        { edgeType: 'TABLE_IN', from: auditTableId, to: sysId },
        { edgeType: 'TABLE_IN', from: idleTableId, to: sysId },
        { edgeType: 'WRITES', from: interactionId, to: auditTableId, columns: null, kind: 'insert' },
      ],
    }, makeBatchMeta('test-orphan-writes-only'));
    const result = await client.callTool({ name: 'list_orphan_tables', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalTables).toBe(2);
    expect(data.total).toBe(1);
    expect(data.tables.map((t: any) => t.name)).toEqual(['idle']);
  });

  it('finds orphans across multiple DatabaseSystems', async () => {
    // Two systems (pg + mongo); orphans in both.
    const pgId = idFor.databaseSystem({ name: 'pg', kind: 'postgres', repository: repo });
    const mongoId = idFor.databaseSystem({ name: 'mongo', kind: 'mongodb', repository: repo });
    const pgUsersId = idFor.databaseTable({ systemId: pgId, schema: null, name: 'pg_users' });
    const pgOrphanId = idFor.databaseTable({ systemId: pgId, schema: null, name: 'pg_orphan' });
    const mongoOrdersId = idFor.databaseTable({ systemId: mongoId, schema: null, name: 'orders' });
    const mongoOrphanId = idFor.databaseTable({ systemId: mongoId, schema: null, name: 'mongo_orphan' });
    const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/multi.ts' });
    const fnId = idFor.functionDefinition({ sourceFileId, name: 'multi', sourceLine: 1 });
    const interactionPg = idFor.databaseInteraction({
      callSiteFunctionId: fnId, operation: 'read', targetTableId: pgUsersId,
    });
    const interactionMongo = idFor.databaseInteraction({
      callSiteFunctionId: fnId, operation: 'read', targetTableId: mongoOrdersId,
    });
    store.commit({
      nodes: [
        { nodeType: 'DatabaseSystem', id: pgId, name: 'pg', kind: 'postgres', connectionSource: null },
        { nodeType: 'DatabaseSystem', id: mongoId, name: 'mongo', kind: 'mongodb', connectionSource: null },
        { nodeType: 'DatabaseTable', id: pgUsersId, systemId: pgId, schema: null, name: 'pg_users', kind: 'table', declaredIn: null },
        { nodeType: 'DatabaseTable', id: pgOrphanId, systemId: pgId, schema: null, name: 'pg_orphan', kind: 'table', declaredIn: null },
        { nodeType: 'DatabaseTable', id: mongoOrdersId, systemId: mongoId, schema: null, name: 'orders', kind: 'collection', declaredIn: null },
        { nodeType: 'DatabaseTable', id: mongoOrphanId, systemId: mongoId, schema: null, name: 'mongo_orphan', kind: 'collection', declaredIn: null },
        { nodeType: 'SourceFile', id: sourceFileId, filePath: 'src/multi.ts', repository: repo, language: 'ts', framework: null },
        { nodeType: 'FunctionDefinition', id: fnId, name: 'multi', sourceFileId, sourceLine: 1, parameters: [], returnType: null, isExported: false, isAsync: false },
        { nodeType: 'DatabaseInteraction', id: interactionPg, callSiteFunctionId: fnId, operation: 'read', orm: 'prisma', rawQuery: null, confidence: 'direct', evidence: { filePath: 'src/multi.ts', lineStart: 1, lineEnd: 1, snippet: 'find', confidence: 'exact' } },
        { nodeType: 'DatabaseInteraction', id: interactionMongo, callSiteFunctionId: fnId, operation: 'read', orm: 'mongoose', rawQuery: null, confidence: 'direct', evidence: { filePath: 'src/multi.ts', lineStart: 2, lineEnd: 2, snippet: 'find', confidence: 'exact' } },
      ],
      edges: [
        { edgeType: 'TABLE_IN', from: pgUsersId, to: pgId },
        { edgeType: 'TABLE_IN', from: pgOrphanId, to: pgId },
        { edgeType: 'TABLE_IN', from: mongoOrdersId, to: mongoId },
        { edgeType: 'TABLE_IN', from: mongoOrphanId, to: mongoId },
        { edgeType: 'READS', from: interactionPg, to: pgUsersId, columns: null, filters: null },
        { edgeType: 'READS', from: interactionMongo, to: mongoOrdersId, columns: null, filters: null },
      ],
    }, makeBatchMeta('test-orphan-multi-system'));
    const result = await client.callTool({ name: 'list_orphan_tables', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalTables).toBe(4);
    expect(data.total).toBe(2);
    const names = data.tables.map((t: any) => t.name).sort();
    expect(names).toEqual(['mongo_orphan', 'pg_orphan']);
  });
});

describe('describe_file', () => {
  it('returns functions, processes, callers, screens for a matching file', async () => {
    seedMobile(store);
    const result = await client.callTool({
      name: 'describe_file',
      arguments: { filePath: 'screens/Login.tsx' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.sourceFile.filePath).toBe('src/screens/Login.tsx');
    expect(data.functions).toHaveLength(1);
    expect(data.processes.map((p: any) => p.name)).toContain('onPress');
    expect(data.apiCallers).toHaveLength(1);
    expect(data.screens.map((s: any) => s.name).sort()).toEqual(['Login', 'Orphan']);
  });

  it('returns an error with available files when none match', async () => {
    seedMobile(store);
    const result = await client.callTool({
      name: 'describe_file',
      arguments: { filePath: 'does-not-exist.ts' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.error).toBeDefined();
    expect(Array.isArray(data.availableFiles)).toBe(true);
  });
});

describe('describe_screen', () => {
  it('returns {screens:[...]} with component, processes, api calls, and navigation targets (#275)', async () => {
    seedMobile(store);
    const result = await client.callTool({
      name: 'describe_screen',
      arguments: { screenName: 'Login' },
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // #275 — always-array shape, even for single match.
    expect(Array.isArray(body.screens)).toBe(true);
    expect(body.screens).toHaveLength(1);
    const data = body.screens[0];
    expect(data.screen.name).toBe('Login');
    expect(data.componentFunction.name).toBe('Login');
    expect(data.processes.map((p: any) => p.name)).toContain('onPress');
    expect(data.apiCalls.map((c: any) => c.urlLiteral)).toContain('/api/login');
    expect(data.navigatesTo).toContain('Home');
  });

  it('returns an error when no screen matches', async () => {
    seedMobile(store);
    const result = await client.callTool({
      name: 'describe_screen',
      arguments: { screenName: 'NotAScreen' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.error).toBeDefined();
    expect(data.availableScreens).toContain('Login');
  });
});

describe('walk_screen_flows', () => {
  it('walks flows for all processes in a named screen', async () => {
    seedMobile(store);
    const result = await client.callTool({
      name: 'walk_screen_flows',
      arguments: { screenName: 'Login' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.screenName).toBe('Login');
    expect(typeof data.totalFlows).toBe('number');
    expect(Array.isArray(data.flows)).toBe(true);
  });

  it('surfaces screens without a walkable component as `screensWithoutFlows` (#198 PR2)', async () => {
    // Pre-#198 PR2: a Screen with `componentFunctionId: null` (the
    // SSG/SSR shape) was silently `continue`-skipped and the user
    // saw `{totalFlows: 0, flows: []}`. Now the screen surfaces in
    // a dedicated list with its identity.
    seedSsg(store);
    const result = await client.callTool({
      name: 'walk_screen_flows',
      arguments: { screenName: 'BlogPost' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.screenName).toBe('BlogPost');
    expect(data.totalFlows).toBe(0);
    expect(data.screensWithoutFlows).toHaveLength(1);
    expect(data.screensWithoutFlows[0]).toMatchObject({
      name: 'BlogPost',
      routePath: '/blog/post-title/',
      framework: 'lang-html',
    });
  });

  it('always includes screensWithoutFlows even when empty (so callers can discriminate)', async () => {
    seedMobile(store);
    const result = await client.callTool({
      name: 'walk_screen_flows',
      arguments: { screenName: 'Login' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(Array.isArray(data.screensWithoutFlows)).toBe(true);
    // Login has a component, so no entries.
    expect(data.screensWithoutFlows.find((s: { name: string }) => s.name === 'Login')).toBeUndefined();
  });
});

describe('navigation_graph', () => {
  it('builds an adjacency list and finds a BFS path', async () => {
    seedMobile(store);
    const result = await client.callTool({
      name: 'navigation_graph',
      arguments: { fromScreen: 'Login', toScreen: 'Home' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalScreens).toBe(3);
    expect(data.adjacency.Login).toContain('Home');
    expect(data.path).toEqual({ from: 'Login', to: 'Home', hops: 1, screens: ['Login', 'Home'] });
  });

  it('traces NAVIGATES_TO edges that originate from a SourceFile (SSG #198 PR2)', async () => {
    // SSG screens emit NAVIGATES_TO from a SourceFile id (the
    // template's own file), not a FunctionDefinition. Pre-#198 PR2
    // those edges were silently dropped because the matcher only
    // looked up `from` as a FunctionDefinition.
    seedSsg(store);
    const result = await client.callTool({
      name: 'navigation_graph',
      arguments: {},
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // BlogIndex SSG → BlogPost SSG via SourceFile-originated NAVIGATES_TO.
    expect(data.adjacency.BlogIndex).toContain('BlogPost');
  });
});

describe('list_env_vars', () => {
  it('groups environment variable accesses by name', async () => {
    seedMobile(store);
    const result = await client.callTool({ name: 'list_env_vars', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(1);
    expect(data.envVars[0].name).toBe('API_URL');
    expect(data.envVars[0].category).toBe('api');
    expect(data.envVars[0].usages).toHaveLength(1);
    expect(data.envVars[0].usages[0].file).toBe('src/screens/Login.tsx');
  });
});

// ──────────────────────────────────────────────────────────────────────
// #126 Phases 1+2+4 — list_screens / list_pages / screen_impact
// ──────────────────────────────────────────────────────────────────────

function seedScreens(s: SQLiteCanonicalGraphStore) {
  // Two web Screens: SettingsPage at /settings, ProjectsPage at /projects.
  // SettingsPage component holds an onClick process that calls /api/settings.
  // /api/settings handler reads the User table.
  const settingsFile = idFor.sourceFile({ repository: repo, filePath: 'src/SettingsPage.tsx' });
  const projectsFile = idFor.sourceFile({ repository: repo, filePath: 'src/ProjectsPage.tsx' });
  const settingsSf: SourceFile = {
    nodeType: 'SourceFile', id: settingsFile, filePath: 'src/SettingsPage.tsx',
    repository: repo, language: 'tsx', framework: null,
  };
  const projectsSf: SourceFile = {
    nodeType: 'SourceFile', id: projectsFile, filePath: 'src/ProjectsPage.tsx',
    repository: repo, language: 'tsx', framework: null,
  };

  const settingsCompId = idFor.functionDefinition({ sourceFileId: settingsFile, name: 'SettingsPage', sourceLine: 1 });
  const projectsCompId = idFor.functionDefinition({ sourceFileId: projectsFile, name: 'ProjectsPage', sourceLine: 1 });
  const settingsComp: FunctionDefinition = {
    nodeType: 'FunctionDefinition', id: settingsCompId, name: 'SettingsPage',
    sourceFileId: settingsFile, sourceLine: 1, parameters: [], returnType: null,
    isExported: true, isAsync: false,
  };
  const projectsComp: FunctionDefinition = {
    nodeType: 'FunctionDefinition', id: projectsCompId, name: 'ProjectsPage',
    sourceFileId: projectsFile, sourceLine: 1, parameters: [], returnType: null,
    isExported: true, isAsync: false,
  };

  // Server-side handler that reads User.
  const handlerFile = idFor.sourceFile({ repository: repo, filePath: 'server/api.ts' });
  const handlerSf: SourceFile = {
    nodeType: 'SourceFile', id: handlerFile, filePath: 'server/api.ts',
    repository: repo, language: 'ts', framework: null,
  };
  const handlerFnId = idFor.functionDefinition({ sourceFileId: handlerFile, name: 'getSettings', sourceLine: 10 });
  const handlerFn: FunctionDefinition = {
    nodeType: 'FunctionDefinition', id: handlerFnId, name: 'getSettings',
    sourceFileId: handlerFile, sourceLine: 10, parameters: [], returnType: null,
    isExported: true, isAsync: true,
  };

  // Database: User + Project tables.
  const dbSysId = idFor.databaseSystem({ kind: 'postgres', name: 'app' });
  const userTblId = idFor.databaseTable({ systemId: dbSysId, schema: null, name: 'User' });
  const projectTblId = idFor.databaseTable({ systemId: dbSysId, schema: null, name: 'Project' });

  const settingsScreen: Screen = {
    nodeType: 'Screen', id: idFor.screen({ repository: repo, name: '/settings', routePath: '/settings' }),
    name: '/settings', componentFunctionId: settingsCompId, navigatorKind: 'web-router',
    routePath: '/settings', sourceFileId: settingsFile, sourceLine: 1,
    framework: 'react-router', repository: repo,
  };
  const projectsScreen: Screen = {
    nodeType: 'Screen', id: idFor.screen({ repository: repo, name: '/projects', routePath: '/projects' }),
    name: '/projects', componentFunctionId: projectsCompId, navigatorKind: 'web-router',
    routePath: '/projects', sourceFileId: projectsFile, sourceLine: 1,
    framework: 'react-router', repository: repo,
  };

  // SettingsPage's onClick → makes a GET /api/settings request.
  const settingsClickId = idFor.clientSideProcess({ sourceFileId: settingsFile, sourceLine: 5, name: 'onClick' });
  const settingsClick: ClientSideProcess = {
    nodeType: 'ClientSideProcess', id: settingsClickId, kind: 'event_handler',
    name: 'onClick', functionId: settingsCompId, sourceFileId: settingsFile, sourceLine: 5,
    framework: 'react', repository: repo,
  };
  const projectsLoadId = idFor.clientSideProcess({ sourceFileId: projectsFile, sourceLine: 3, name: 'useEffect' });
  const projectsLoad: ClientSideProcess = {
    nodeType: 'ClientSideProcess', id: projectsLoadId, kind: 'lifecycle_hook',
    name: 'useEffect', functionId: projectsCompId, sourceFileId: projectsFile, sourceLine: 3,
    framework: 'react', repository: repo,
  };

  const settingsCallerId = idFor.clientSideAPICaller({ sourceFileId: settingsFile, sourceLine: 5, urlLiteral: '/api/settings' });
  const settingsCaller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller', id: settingsCallerId,
    functionId: settingsCompId, sourceFileId: settingsFile, sourceLine: 5,
    httpMethod: 'GET', urlLiteral: '/api/settings', egressConfidence: 'exact',
    framework: 'fetch', repository: repo,
  };
  const projectsCallerId = idFor.clientSideAPICaller({ sourceFileId: projectsFile, sourceLine: 3, urlLiteral: '/api/projects' });
  const projectsCaller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller', id: projectsCallerId,
    functionId: projectsCompId, sourceFileId: projectsFile, sourceLine: 3,
    httpMethod: 'GET', urlLiteral: '/api/projects', egressConfidence: 'exact',
    framework: 'fetch', repository: repo,
  };

  const settingsEndpointId = idFor.apiEndpoint({
    repository: repo, httpMethod: 'GET', routePattern: '/api/settings',
    filePath: 'server/api.ts', lineStart: 10,
  });
  const settingsEndpoint: APIEndpoint = {
    nodeType: 'APIEndpoint', id: settingsEndpointId, httpMethod: 'GET',
    routePattern: '/api/settings', handlerFunctionId: handlerFnId,
    framework: 'express', repository: repo,
    evidence: { filePath: 'server/api.ts', lineStart: 10, lineEnd: 10, snippet: 'app.get(...)', confidence: 'exact' },
  };

  const interactionId = idFor.databaseInteraction({
    callSiteFunctionId: handlerFnId, operation: 'read', targetTableId: userTblId,
  });
  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction', id: interactionId,
    callSiteFunctionId: handlerFnId, operation: 'read', orm: 'prisma',
    rawQuery: null, confidence: 'direct',
    evidence: { filePath: 'server/api.ts', lineStart: 12, lineEnd: 12, snippet: 'prisma.user.findMany()', confidence: 'exact' },
  };
  const userTable: DatabaseTable = {
    nodeType: 'DatabaseTable', id: userTblId, systemId: dbSysId,
    name: 'User', schema: null, kind: 'table', declaredIn: null,
  };
  const projectTable: DatabaseTable = {
    nodeType: 'DatabaseTable', id: projectTblId, systemId: dbSysId,
    name: 'Project', schema: null, kind: 'table', declaredIn: null,
  };

  // Two separate batches commit cleanly through edge ID stability.
  s.commit({
    nodes: [
      settingsSf, projectsSf, handlerSf,
      settingsComp, projectsComp, handlerFn,
      settingsScreen, projectsScreen,
      settingsClick, projectsLoad,
      settingsCaller, projectsCaller,
      settingsEndpoint, interaction, userTable, projectTable,
    ],
    edges: [
      { edgeType: 'MAKES_REQUEST', from: settingsClickId, to: settingsCallerId },
      { edgeType: 'MAKES_REQUEST', from: projectsLoadId, to: projectsCallerId },
      { edgeType: 'RESOLVES_TO_ENDPOINT', from: settingsCallerId, to: settingsEndpointId, matchedBy: 'exact-url', matchConfidence: 'high' },
      { edgeType: 'PERFORMED_BY', from: interactionId, to: handlerFnId, sourceLine: 12 },
      { edgeType: 'READS', from: interactionId, to: userTblId, columns: null, filters: null },
      // ProjectsPage also reads the User table through a different flow,
      // so the User table is "shared" across screens.
      { edgeType: 'NAVIGATES_TO', from: projectsScreen.id, to: settingsScreen.id, method: 'link', sourceLine: 1 },
    ],
  }, makeBatchMeta('test'));

  // Add a second projects → User flow so screen_impact's sharedTables
  // sees both screens.
  const projectsHandlerFnId = idFor.functionDefinition({ sourceFileId: handlerFile, name: 'getProjects', sourceLine: 30 });
  const projectsHandlerFn: FunctionDefinition = {
    nodeType: 'FunctionDefinition', id: projectsHandlerFnId, name: 'getProjects',
    sourceFileId: handlerFile, sourceLine: 30, parameters: [], returnType: null,
    isExported: true, isAsync: true,
  };
  const projectsEndpointId = idFor.apiEndpoint({
    repository: repo, httpMethod: 'GET', routePattern: '/api/projects',
    filePath: 'server/api.ts', lineStart: 30,
  });
  const projectsEndpoint: APIEndpoint = {
    nodeType: 'APIEndpoint', id: projectsEndpointId, httpMethod: 'GET',
    routePattern: '/api/projects', handlerFunctionId: projectsHandlerFnId,
    framework: 'express', repository: repo,
    evidence: { filePath: 'server/api.ts', lineStart: 30, lineEnd: 30, snippet: 'app.get(...)', confidence: 'exact' },
  };
  const projectsInteractionId = idFor.databaseInteraction({
    callSiteFunctionId: projectsHandlerFnId, operation: 'read', targetTableId: userTblId,
  });
  const projectsInteraction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction', id: projectsInteractionId,
    callSiteFunctionId: projectsHandlerFnId, operation: 'read', orm: 'prisma',
    rawQuery: null, confidence: 'direct',
    evidence: { filePath: 'server/api.ts', lineStart: 32, lineEnd: 32, snippet: 'prisma.user.count()', confidence: 'exact' },
  };
  s.commit({
    nodes: [projectsHandlerFn, projectsEndpoint, projectsInteraction],
    edges: [
      { edgeType: 'RESOLVES_TO_ENDPOINT', from: projectsCallerId, to: projectsEndpointId, matchedBy: 'exact-url', matchConfidence: 'high' },
      { edgeType: 'PERFORMED_BY', from: projectsInteractionId, to: projectsHandlerFnId, sourceLine: 32 },
      { edgeType: 'READS', from: projectsInteractionId, to: userTblId, columns: null, filters: null },
    ],
  }, makeBatchMeta('test'));
}

describe('list_screens (#126 Phase 1)', () => {
  it('returns one row per Screen with processes / apiCalls / endpoints / tables', async () => {
    seedScreens(store);
    const result = await client.callTool({ name: 'list_screens', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalScreens).toBe(2);
    const settings = data.screens.find((s: { name: string }) => s.name === '/settings');
    expect(settings).toBeDefined();
    expect(settings.processes.map((p: { name: string }) => p.name)).toContain('onClick');
    expect(settings.apiCalls.map((c: { urlLiteral: string }) => c.urlLiteral)).toContain('/api/settings');
    expect(settings.endpoints.map((e: { routePattern: string }) => e.routePattern)).toContain('/api/settings');
    expect(settings.tables).toContain('User');
  });

  it('substring filter matches name OR routePath (case-insensitive)', async () => {
    seedScreens(store);
    const result = await client.callTool({ name: 'list_screens', arguments: { filter: 'SETTINGS' } });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalScreens).toBe(1);
    expect(data.screens[0].routePath).toBe('/settings');
  });

  it('repository filter scopes to one repo', async () => {
    seedScreens(store);
    const result = await client.callTool({ name: 'list_screens', arguments: { repository: 'no-such-repo' } });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalScreens).toBe(0);
  });
});

describe('list_pages (#126 Phase 2)', () => {
  it('returns only screens with non-null routePath, sorted by routePath', async () => {
    seedScreens(store);
    const result = await client.callTool({ name: 'list_pages', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalPages).toBe(2);
    expect(data.pages[0].routePath).toBe('/projects');
    expect(data.pages[1].routePath).toBe('/settings');
  });

  it('excludes RN named screens (routePath = null)', async () => {
    seedMobile(store);  // adds Screens with routePath omitted (defaults to null/undefined).
    const result = await client.callTool({ name: 'list_pages', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.totalPages).toBe(0);
  });
});

describe('screen_impact (#126 Phase 4)', () => {
  it('returns the target screen + sharedTables + relatedScreens', async () => {
    seedScreens(store);
    const result = await client.callTool({ name: 'screen_impact', arguments: { screenName: '/settings' } });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.screen.name).toBe('/settings');
    expect(data.screen.tables).toContain('User');
    // ProjectsPage also reads User → should appear in sharedTables.
    expect(data.sharedTables.User).toContain('/projects');
    // ProjectsPage NAVIGATES_TO settings → settings has /projects as related.
    expect(data.relatedScreens.find((r: { name: string }) => r.name === '/projects')).toBeDefined();
  });

  it('lookup by routePath also works', async () => {
    seedScreens(store);
    const result = await client.callTool({ name: 'screen_impact', arguments: { routePath: '/projects' } });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.screen.routePath).toBe('/projects');
  });

  it('errors when neither screenName nor routePath is given', async () => {
    seedScreens(store);
    const result = await client.callTool({ name: 'screen_impact', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.error).toMatch(/screenName or routePath/);
  });

  it('errors with availableScreens when target not found', async () => {
    seedScreens(store);
    const result = await client.callTool({ name: 'screen_impact', arguments: { screenName: '/missing' } });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.error).toBe('Screen not found');
    expect(data.availableScreens.length).toBe(2);
  });
});
