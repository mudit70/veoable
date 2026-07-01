import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
// zod removed — REST server uses runtime type checks, not schema validation
import type { CanonicalGraphStore } from '@adorable/graph-db';
import { makeBatchMeta } from '@adorable/plugin-api';
import {
  FLOW_STITCHER_PRODUCER_ID,
  createFlowWalker,
  matchCallerToEndpoints,
  stitchStore,
} from '@adorable/flow-stitcher';
import { EDGE_TYPES } from '@adorable/schema';
import type { NodeType, EdgeType, SchemaNode } from '@adorable/schema';
import { getSkillMarkdown } from '@adorable/skill';

/**
 * Tool definition for the REST API. Each tool has a name, description,
 * parameter schema (in OpenAI function-calling format), and an async
 * handler that takes validated params and returns a JSON-serializable result.
 */
interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface RestServerOptions {
  projectRoot?: string;
  port?: number;
  projectConfigPath?: string;
  dbPath?: string;
}

/**
 * Create an HTTP server that exposes the Adorable knowledge graph tools
 * as a REST API. Each MCP tool becomes a POST endpoint:
 *
 *   GET  /api/tools              → list all tools with schemas
 *   POST /api/tools/:toolName    → execute a tool
 *
 * The response format matches the tool's output. Error responses use
 * HTTP status codes (400 for bad input, 404 for unknown tool, 500 for
 * internal errors).
 */
export function createRestServer(store: CanonicalGraphStore, opts?: RestServerOptions) {
  const projectRoot = opts?.projectRoot;
  const port = opts?.port ?? 3001;

  const configPath = opts?.projectConfigPath;
  const tools = buildToolDefs(store, projectRoot, configPath, opts?.dbPath);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = http.createServer(async (req, res) => {
    // CORS headers for web UI consumption.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    try {
      // GET /api/tools — list all tools with OpenAI function-calling schemas.
      if (req.method === 'GET' && url.pathname === '/api/tools') {
        const toolSchemas = tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
        sendJson(res, 200, { tools: toolSchemas });
        return;
      }

      // POST /api/tools/:toolName — execute a tool.
      const toolMatch = url.pathname.match(/^\/api\/tools\/([a-z_]+)$/);
      if (req.method === 'POST' && toolMatch) {
        const toolName = toolMatch[1];
        const tool = toolMap.get(toolName);
        if (!tool) {
          sendJson(res, 404, { error: `Unknown tool: ${toolName}` });
          return;
        }

        const body = await readBody(req);
        let params: Record<string, unknown>;
        try {
          params = body ? JSON.parse(body) : {};
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        const result = await tool.handler(params);
        sendJson(res, 200, { result });
        return;
      }

      // Health check.
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      sendJson(res, statusCode, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    server,
    port,
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(port, () => resolve());
      }),
    tools,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tool definitions
// ──────────────────────────────────────────────────────────────────────

function buildToolDefs(store: CanonicalGraphStore, projectRoot?: string, projectConfigPath?: string, dbPath?: string): ToolDef[] {
  // Resolve project name: config file → DB filename → null.
  let projectName: string | null = null;
  if (projectConfigPath) {
    try {
      const config = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
      projectName = config.name ?? null;
    } catch { /* ignore */ }
  }
  if (!projectName && dbPath) {
    projectName = path.basename(dbPath, path.extname(dbPath));
  }
  const NODE_TYPES = [
    'SourceFile', 'FunctionDefinition', 'APIEndpoint', 'ClientSideAPICaller',
    'ClientSideProcess', 'DatabaseSystem', 'DatabaseTable', 'DatabaseColumn',
    'DatabaseInteraction',
  ];

  // #290 — EDGE_TYPES imported from @adorable/schema; single source
  // of truth for what edge types exist. Pre-fix this was a local list
  // missing 6 of 19 canonical edge types (NAVIGATES_TO, SCREEN_COMPONENT,
  // RENDERS, READS_STATE, WRITES_STATE, BUNDLES_TO).

  return [
    {
      name: 'describe_skill',
      description:
        "Return the canonical Adorable skill description (SKILL.md): when to invoke Adorable tools, when not to, and the recommended tool chains for common questions. Call this once at session start if you don't already have the Adorable skill loaded, if you're unsure whether a question should be answered with Adorable, or if you need a refresher on which tool fits which question shape.",
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ markdown: getSkillMarkdown() }),
    },
    {
      name: 'list_repositories',
      description: 'Return the project name and all repositories in the knowledge graph with per-repo node counts',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const repos = store.listRepositories();
        const enriched = repos.map((r) => {
          const sourceFiles = store.findNodes('SourceFile', { repository: r.repository } as any);
          const languages = [...new Set(sourceFiles.map((sf) => sf.language))].sort();
          const frameworks = new Set<string>();
          for (const ep of store.findNodes('APIEndpoint', { repository: r.repository } as any)) {
            if (ep.framework) frameworks.add(ep.framework);
          }
          for (const c of store.findNodes('ClientSideAPICaller', { repository: r.repository } as any)) {
            if (c.framework) frameworks.add(c.framework);
          }
          for (const p of store.findNodes('ClientSideProcess', { repository: r.repository } as any)) {
            if (p.framework) frameworks.add(p.framework);
          }
          return { ...r, languages, frameworks: [...frameworks].sort() };
        });
        return {
          ...(projectName ? { project: projectName } : {}),
          repositories: enriched,
        };
      },
    },

    {
      name: 'list_nodes',
      description: 'List nodes in the knowledge graph by type, with optional property filters',
      parameters: {
        type: 'object',
        properties: {
          nodeType: { type: 'string', enum: NODE_TYPES, description: 'The node type to list' },
          filter: { type: 'object', description: 'Optional key-value property filter (AND semantics)' },
        },
        required: ['nodeType'],
      },
      handler: async (params) => {
        return store.findNodes(
          params.nodeType as NodeType,
          params.filter as Partial<SchemaNode> | undefined
        );
      },
    },

    {
      name: 'get_node',
      description: 'Get a single node by its type and content-addressed id',
      parameters: {
        type: 'object',
        properties: {
          nodeType: { type: 'string', enum: NODE_TYPES, description: 'The node type' },
          id: { type: 'string', description: 'The content-addressed node id' },
        },
        required: ['nodeType', 'id'],
      },
      handler: async (params) => {
        const node = store.getNode(params.nodeType as NodeType, params.id as string);
        if (!node) throw Object.assign(new Error('Node not found'), { statusCode: 404 });
        return node;
      },
    },

    {
      name: 'find_edges',
      description: 'Find edges by source node id, target node id, and/or edge type. All filters are optional — pass any combination (e.g. just `edgeType` for "all edges of this type").',
      parameters: {
        type: 'object',
        properties: {
          from: { type: ['string', 'null'], description: 'Source node id, or null/omit to wildcard' },
          to: { type: ['string', 'null'], description: 'Target node id, or null/omit to wildcard' },
          edgeType: { type: 'string', enum: EDGE_TYPES, description: 'Optional edge type filter' },
        },
      },
      handler: async (params) => {
        return store.findEdges(
          (params.from ?? null) as string | null,
          (params.to ?? null) as string | null,
          params.edgeType as EdgeType | undefined
        );
      },
    },

    {
      name: 'walk_all_flows',
      description: 'Walk end-to-end flows for every ClientSideProcess in the graph',
      parameters: {
        type: 'object',
        properties: {
          maxCallDepth: { type: 'number', description: 'Max call-graph traversal depth (default: 10)' },
          repository: { type: 'string', description: 'Only flows originating from this repository' },
          maxHops: { type: 'number', description: 'Max service-to-service hops (default: 1, max: 5). Set to 2+ for microservice architectures.' },
          completenessFilter: { type: 'string', description: 'Filter by completeness level' },
          filterByTable: { type: 'string', description: 'Only flows that read/write this table name' },
          filterByEndpoint: { type: 'string', description: 'Only flows matching this route pattern prefix' },
          countOnly: { type: 'boolean', description: 'Return only the count of flows' },
        },
      },
      handler: async (params) => {
        const walker = createFlowWalker(store, {
          maxCallDepth: (params.maxCallDepth as number) ?? 10,
          maxHops: (params.maxHops as number) ?? 1,
        });
        let flows = walker.walkAllProcesses();
        if (params.repository) {
          flows = flows.filter((f) => f.startProcess.repository === params.repository);
        }
        if (params.completenessFilter) {
          flows = flows.filter((f) => f.completeness === params.completenessFilter);
        }
        if (params.filterByTable) {
          const tableName = params.filterByTable as string;
          flows = flows.filter((f) => {
            const hopsTouch = (hops: Array<{ readsTables: Array<{ name: string }>; writesTables: Array<{ name: string }> }>) =>
              hops.some((hop) => hop.readsTables.some((t) => t.name === tableName) || hop.writesTables.some((t) => t.name === tableName));
            if (hopsTouch(f.databaseHops)) return true;
            const checkSH = (sh: typeof f.serviceHops): boolean => sh.some((h) => hopsTouch(h.databaseHops) || checkSH(h.downstreamCalls));
            return checkSH(f.serviceHops);
          });
        }
        if (params.filterByEndpoint) {
          const prefix = params.filterByEndpoint as string;
          flows = flows.filter((f) => f.endpoint?.routePattern?.startsWith(prefix));
        }
        if (params.countOnly) {
          return { total: flows.length };
        }
        // Return formatted flows (same shape as MCP).
        return flows.map((flow) => ({
          completeness: flow.completeness,
          startProcess: flow.startProcess ? { id: flow.startProcess.id, kind: flow.startProcess.kind, name: flow.startProcess.name } : null,
          caller: flow.caller ? { id: flow.caller.id, httpMethod: flow.caller.httpMethod, urlLiteral: flow.caller.urlLiteral, egressConfidence: flow.caller.egressConfidence, ...(flow.caller.isExternal ? { isExternal: true, externalHost: flow.caller.externalHost } : {}) } : null,
          endpoint: flow.endpoint ? { id: flow.endpoint.id, httpMethod: flow.endpoint.httpMethod, routePattern: flow.endpoint.routePattern, framework: flow.endpoint.framework } : null,
          handlerFunction: flow.handlerFunction ? { id: flow.handlerFunction.id, name: flow.handlerFunction.name } : null,
          databaseHops: flow.databaseHops.map((hop) => ({ operation: hop.interaction.operation, orm: hop.interaction.orm, readsTables: hop.readsTables.map((t) => t.name), writesTables: hop.writesTables.map((t) => t.name) })),
          serviceHops: flow.serviceHops.length > 0 ? formatServiceHopsRest(flow.serviceHops) : [],
        }));
      },
    },

    {
      name: 'walk_flows',
      description: 'Walk end-to-end flows starting from a specific ClientSideProcess',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'string', description: 'The ClientSideProcess id to start from' },
          maxCallDepth: { type: 'number', description: 'Max call-graph traversal depth (default: 10)' },
          maxHops: { type: 'number', description: 'Max service-to-service hops (default: 1)' },
        },
        required: ['processId'],
      },
      handler: async (params) => {
        const walker = createFlowWalker(store, {
          maxCallDepth: (params.maxCallDepth as number) ?? 10,
          maxHops: (params.maxHops as number) ?? 1,
        });
        const flows = walker.walkFromProcess(params.processId as string);
        return flows.map((flow) => ({
          completeness: flow.completeness,
          startProcess: flow.startProcess ? { id: flow.startProcess.id, kind: flow.startProcess.kind, name: flow.startProcess.name } : null,
          caller: flow.caller ? { id: flow.caller.id, httpMethod: flow.caller.httpMethod, urlLiteral: flow.caller.urlLiteral } : null,
          endpoint: flow.endpoint ? { id: flow.endpoint.id, httpMethod: flow.endpoint.httpMethod, routePattern: flow.endpoint.routePattern } : null,
          handlerFunction: flow.handlerFunction ? { id: flow.handlerFunction.id, name: flow.handlerFunction.name } : null,
          databaseHops: flow.databaseHops.map((hop) => ({ operation: hop.interaction.operation, orm: hop.interaction.orm, readsTables: hop.readsTables.map((t) => t.name), writesTables: hop.writesTables.map((t) => t.name) })),
          serviceHops: flow.serviceHops.length > 0 ? formatServiceHopsRest(flow.serviceHops) : [],
        }));
      },
    },

    {
      name: 'stitch',
      description: 'Run the URL stitcher to emit RESOLVES_TO_ENDPOINT edges',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const batch = stitchStore(store);
        store.commit(batch, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));
        return {
          edgesEmitted: batch.edges.length,
          message: batch.edges.length > 0
            ? `Stitched ${batch.edges.length} RESOLVES_TO_ENDPOINT edge(s)`
            : 'No new edges to stitch',
        };
      },
    },

    {
      name: 'list_server_endpoints',
      description: 'List all API endpoints with their downstream effects',
      parameters: {
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'Only endpoints from this repository' },
        },
      },
      handler: async (params) => {
        const endpoints = store.findNodes('APIEndpoint', params.repository ? { repository: params.repository } as any : undefined);
        return endpoints.map((ep) => {
          const handler = ep.handlerFunctionId
            ? store.getNode('FunctionDefinition', ep.handlerFunctionId)
            : null;
          return {
            id: ep.id,
            httpMethod: ep.httpMethod,
            routePattern: ep.routePattern,
            handler: handler?.name ?? null,
            handlerResolved: handler !== null,
            framework: ep.framework,
          };
        });
      },
    },

    {
      name: 'list_client_api_calls',
      description: 'List all outbound API calls from the client-side code with trigger context',
      parameters: {
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'Only callers from this repository' },
        },
      },
      handler: async (params) => {
        const callers = store.findNodes('ClientSideAPICaller', params.repository ? { repository: params.repository } as any : undefined);
        return callers.map((caller) => ({
          id: caller.id,
          httpMethod: caller.httpMethod,
          url: caller.urlLiteral,
          urlConfidence: caller.egressConfidence,
          sourceLine: caller.sourceLine,
        }));
      },
    },

    {
      name: 'suggest_stitches',
      description: 'Propose matches between client-side API calls and server-side endpoints',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const callers = store.findNodes('ClientSideAPICaller');
        const endpoints = store.findNodes('APIEndpoint');
        const matcherEndpoints = endpoints.map((e) => ({
          id: e.id, httpMethod: e.httpMethod, routePattern: e.routePattern,
        }));

        const suggestions = [];
        for (const caller of callers) {
          if (caller.urlLiteral === null || caller.egressConfidence === 'dynamic') continue;
          const results = matchCallerToEndpoints(
            {
              id: caller.id,
              httpMethod: caller.httpMethod,
              urlLiteral: caller.urlLiteral,
              egressConfidence: caller.egressConfidence,
              templateSpanCount: caller.templateSpanCount ?? null,
              templateSegmentCount: caller.templateSegmentCount ?? null,
              templateParts: caller.templateParts ?? null,
            },
            matcherEndpoints
          );

          suggestions.push({
            callerId: caller.id,
            callerUrl: `${caller.httpMethod ?? '?'} ${caller.urlLiteral}`,
            matches: results.map((r) => {
              const ep = endpoints.find((e) => e.id === r.endpointId)!;
              return {
                endpointId: r.endpointId,
                endpoint: `${ep.httpMethod} ${ep.routePattern}`,
                confidence: r.matchConfidence,
                matchedBy: r.matchedBy,
              };
            }),
          });
        }
        return suggestions;
      },
    },

    {
      name: 'get_source_file',
      description: 'Retrieve source file content for a graph node OR a file path. Pass either `nodeId` (content-addressed) or `filePath` (full or substring; first match wins).',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The node id to look up source for' },
          filePath: { type: 'string', description: 'A file path or substring; matches against SourceFile.filePath' },
          contextLines: { type: 'number', description: 'Extra lines of context (default: 5)' },
        },
      },
      handler: async (params) => {
        if (!projectRoot) throw new Error('get_source_file requires --project-root');

        if (!params.nodeId && !params.filePath) {
          throw Object.assign(new Error('Pass either nodeId or filePath'), { statusCode: 400 });
        }
        let node = params.nodeId
          ? store.getNodeById(params.nodeId as string)
          : null;
        // Fall back to filePath lookup when nodeId is missing OR when
        // the nodeId lookup returned null (so callers can pass both
        // and the resolver "tries hardest").
        if (!node && params.filePath) {
          const index = getSourceFileIndex(store);
          const fp = params.filePath as string;
          const exact = index.byExactPath.get(fp);
          let partial: typeof exact = undefined;
          if (!exact) {
            for (const sf of index.byExactPath.values()) {
              if (sf.filePath.includes(fp)) {
                partial = sf;
                break;
              }
            }
          }
          node = exact ?? partial ?? null;
        }
        if (!node) throw Object.assign(new Error('Node not found'), { statusCode: 404 });

        let filePath: string | null = null;
        let lineStart: number | null = null;
        let lineEnd: number | null = null;

        if ('evidence' in node && node.evidence) {
          filePath = node.evidence.filePath;
          lineStart = node.evidence.lineStart;
          lineEnd = node.evidence.lineEnd;
        } else if ('sourceFileId' in node) {
          const sf = store.getNode('SourceFile', node.sourceFileId);
          if (sf) filePath = sf.filePath;
        } else if (node.nodeType === 'SourceFile') {
          filePath = node.filePath;
        }

        if (!filePath) throw new Error('Could not determine source file path');

        const absolutePath = path.resolve(projectRoot, filePath);
        const safePRoot = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
        if (!absolutePath.startsWith(safePRoot) && absolutePath !== projectRoot) {
          throw new Error('Path traversal denied');
        }

        const content = await fs.readFile(absolutePath, 'utf-8');
        const lines = content.split('\n');
        const ctx = Math.min(Math.max(0, (params.contextLines as number) ?? 5), 200);

        if (lineStart !== null && lineEnd !== null) {
          const start = Math.max(0, lineStart - 1 - ctx);
          const end = Math.min(lines.length, lineEnd + ctx);
          return {
            filePath,
            totalLines: lines.length,
            evidenceRange: { lineStart, lineEnd },
            displayRange: { lineStart: start + 1, lineEnd: end },
            content: lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n'),
          };
        }

        return {
          filePath,
          totalLines: lines.length,
          content: lines.map((l, i) => `${i + 1}\t${l}`).join('\n'),
        };
      },
    },

    {
      name: 'confirm_stitch',
      description: 'Confirm a match between a client-side API caller and a server-side endpoint',
      parameters: {
        type: 'object',
        properties: {
          callerId: { type: 'string', description: 'The ClientSideAPICaller node id' },
          endpointId: { type: 'string', description: 'The APIEndpoint node id' },
          reason: { type: 'string', description: 'Why this match is correct' },
        },
        required: ['callerId', 'endpointId'],
      },
      handler: async (params) => {
        const caller = store.getNode('ClientSideAPICaller', params.callerId as string);
        if (!caller) throw Object.assign(new Error('Caller not found'), { statusCode: 404 });
        const endpoint = store.getNode('APIEndpoint', params.endpointId as string);
        if (!endpoint) throw Object.assign(new Error('Endpoint not found'), { statusCode: 404 });

        const existing = store.findEdges(caller.id, endpoint.id, 'RESOLVES_TO_ENDPOINT');
        if (existing.length > 0) return { message: 'Already stitched', existingEdge: existing[0] };

        const matchedBy = caller.egressConfidence === 'exact' && caller.urlLiteral === endpoint.routePattern
          ? 'exact-url' as const : 'pattern' as const;

        const edge = {
          edgeType: 'RESOLVES_TO_ENDPOINT' as const,
          from: caller.id, to: endpoint.id,
          matchedBy, matchConfidence: 'high' as const,
          confirmedBy: 'human' as const,
          confirmedAt: new Date().toISOString(),
          strategy: 'manual-confirmation',
          reason: (params.reason as string) ?? undefined,
          fromRepository: caller.repository, toRepository: endpoint.repository,
        };
        store.commit({ nodes: [], edges: [edge] }, makeBatchMeta('stitch-confirm'));
        return { message: 'Confirmed', edge };
      },
    },

    {
      name: 'reject_stitch',
      description: 'Record rejection of a proposed match (edge deletion not yet supported)',
      parameters: {
        type: 'object',
        properties: {
          callerId: { type: 'string', description: 'The ClientSideAPICaller node id' },
          endpointId: { type: 'string', description: 'The APIEndpoint node id' },
          reason: { type: 'string', description: 'Why this match is wrong' },
        },
        required: ['callerId', 'endpointId'],
      },
      handler: async (params) => {
        return {
          message: `Rejection recorded for ${params.callerId} → ${params.endpointId}`,
          reason: (params.reason as string) ?? 'No reason provided',
          note: 'Edge deletion not yet supported',
        };
      },
    },

    {
      name: 'auto_stitch',
      description: 'Auto-accept stitch suggestions at or above a confidence level',
      parameters: {
        type: 'object',
        properties: {
          minConfidence: { type: 'string', enum: ['deterministic', 'heuristic', 'all'], description: 'Minimum confidence (default: deterministic)' },
          dryRun: { type: 'boolean', description: 'Preview without committing (default: false)' },
        },
      },
      handler: async (params) => {
        const tier = (params.minConfidence as string) ?? 'deterministic';
        const preview = (params.dryRun as boolean) ?? false;
        const callers = store.findNodes('ClientSideAPICaller');
        const endpoints = store.findNodes('APIEndpoint');
        const matcherEndpoints = endpoints.map((e) => ({
          id: e.id, httpMethod: e.httpMethod, routePattern: e.routePattern,
        }));

        const edges: Array<Record<string, unknown>> = [];
        for (const caller of callers) {
          if (caller.urlLiteral === null || caller.egressConfidence === 'dynamic') continue;
          if (store.findEdges(caller.id, null, 'RESOLVES_TO_ENDPOINT').length > 0) continue;

          const results = matchCallerToEndpoints(
            { id: caller.id, httpMethod: caller.httpMethod, urlLiteral: caller.urlLiteral,
              egressConfidence: caller.egressConfidence,
              templateSpanCount: caller.templateSpanCount ?? null,
              templateSegmentCount: caller.templateSegmentCount ?? null },
            matcherEndpoints
          );
          if (results.length === 0) continue;
          const topRank = results[0].matchRank;
          const topMatches = results.filter((r) => r.matchRank === topRank);
          if (topMatches.length > 1) continue;
          const match = topMatches[0];
          if (tier === 'deterministic' && match.matchConfidence !== 'high') continue;
          if (tier === 'heuristic' && match.matchConfidence === 'low') continue;

          const ep = endpoints.find((e) => e.id === match.endpointId)!;
          edges.push({
            edgeType: 'RESOLVES_TO_ENDPOINT', from: caller.id, to: match.endpointId,
            matchedBy: match.matchedBy, matchConfidence: match.matchConfidence,
            confirmedBy: 'auto', confirmedAt: new Date().toISOString(),
            strategy: `auto-stitch-${tier}`,
            fromRepository: caller.repository, toRepository: ep.repository,
          });
        }

        if (!preview && edges.length > 0) {
          store.commit({ nodes: [], edges: edges as any }, makeBatchMeta('auto-stitch'));
        }
        return { mode: preview ? 'dry-run' : 'committed', edgesCount: edges.length };
      },
    },

    {
      name: 'list_unmatched_callers',
      description: 'List ClientSideAPICallers with no RESOLVES_TO_ENDPOINT edge. External API calls excluded by default.',
      parameters: {
        type: 'object',
        properties: {
          includeExternal: { type: 'boolean', description: 'Include external API calls (default: false)' },
        },
      },
      handler: async (params) => {
        const callers = store.findNodes('ClientSideAPICaller');
        return callers.filter((c) => {
          if (!params.includeExternal && c.isExternal) return false;
          return store.findEdges(c.id, null, 'RESOLVES_TO_ENDPOINT').length === 0;
        });
      },
    },

    {
      name: 'list_incomplete_flows',
      description: 'List flows that stopped before reaching the database',
      parameters: {
        type: 'object',
        properties: {
          maxCallDepth: { type: 'number', description: 'Max traversal depth (default: 10)' },
          maxHops: { type: 'number', description: 'Max service-to-service hops (default: 1, max: 5)' },
        },
      },
      handler: async (params) => {
        const walker = createFlowWalker(store, { maxCallDepth: (params.maxCallDepth as number) ?? 10, maxHops: (params.maxHops as number) ?? 1 });
        return walker.walkAllProcesses().filter((f) => f.completeness !== 'complete');
      },
    },

    {
      name: 'stitch_report',
      description: 'Comprehensive stitching report: what was stitched and why, what was not and why not',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const callers = store.findNodes('ClientSideAPICaller');
        const endpoints = store.findNodes('APIEndpoint');
        const allStitchEdges = store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT');
        const stitchedCallerIds = new Set(allStitchEdges.map((e) => e.from));

        const stitched = allStitchEdges.map((edge) => {
          const caller = store.getNode('ClientSideAPICaller', edge.from);
          const ep = store.getNode('APIEndpoint', edge.to);
          return {
            caller: caller ? `${caller.httpMethod ?? '?'} ${caller.urlLiteral}` : edge.from,
            endpoint: ep ? `${ep.httpMethod} ${ep.routePattern}` : edge.to,
            callerRepo: caller?.repository ?? '?',
            endpointRepo: ep?.repository ?? '?',
          };
        });

        const unresolved: Array<{ url: string; repo: string; candidates: Array<{ endpoint: string; repo: string; issue: string }> }> = [];
        const dynamic: Array<Record<string, unknown>> = [];
        const external: Array<{ host: string; httpMethod: string | null; url: string; repo: string }> = [];

        for (const caller of callers) {
          if (stitchedCallerIds.has(caller.id)) continue;
          if (caller.isExternal && caller.externalHost) {
            external.push({ host: caller.externalHost, httpMethod: caller.httpMethod, url: caller.urlLiteral ?? '<dynamic>', repo: caller.repository });
            continue;
          }
          if (!caller.urlLiteral || caller.egressConfidence === 'dynamic') {
            const enclosingFn = store.getNode('FunctionDefinition', caller.functionId);
            const sourceFile = store.getNode('SourceFile', caller.sourceFileId);
            dynamic.push({
              callerId: caller.id,
              repo: caller.repository,
              httpMethod: caller.httpMethod,
              sourceFile: sourceFile?.filePath ?? null,
              sourceLine: caller.sourceLine,
              enclosingFunction: enclosingFn?.name ?? null,
              evidence: caller.evidence?.snippet ?? null,
            });
            continue;
          }

          const candidates: Array<{ endpoint: string; repo: string; issue: string }> = [];
          for (const ep of endpoints) {
            if (caller.httpMethod && ep.httpMethod !== caller.httpMethod) continue;
            const callerPath = caller.urlLiteral.replace(/\/$/, '');
            const epPath = ep.routePattern.replace(/\/$/, '');
            if (callerPath.endsWith(epPath) || epPath.endsWith(callerPath)) {
              const diff = callerPath.length > epPath.length
                ? callerPath.slice(0, callerPath.length - epPath.length)
                : '';
              candidates.push({
                endpoint: `${ep.httpMethod} ${ep.routePattern}`,
                repo: ep.repository,
                issue: diff ? `prefix-mismatch: "${diff}"` : 'should-match',
              });
            }
          }
          if (candidates.length > 0) {
            unresolved.push({
              url: `${caller.httpMethod ?? '?'} ${caller.urlLiteral}`,
              repo: caller.repository,
              candidates: candidates.slice(0, 5),
            });
          }
        }

        // Group external by host.
        const extByHost = Object.entries(
          external.reduce<Record<string, typeof external>>((acc, e) => { (acc[e.host] ??= []).push(e); return acc; }, {})
        ).map(([host, calls]) => ({ host, callCount: calls.length, methods: [...new Set(calls.map(c => c.httpMethod).filter(Boolean))] }));

        return {
          summary: { stitched: stitched.length, unresolved: unresolved.length, dynamic: dynamic.length, external: external.length },
          stitched: stitched.slice(0, 10),
          unresolved: unresolved.slice(0, 15),
          dynamic: dynamic.slice(0, 10),
          externalByHost: extByHost,
        };
      },
    },

    {
      name: 'ai_stitch_review',
      description: 'Analyze unresolved callers and propose stitching rules or observations',
      parameters: {
        type: 'object',
        properties: { maxCallers: { type: 'number', description: 'Max callers to analyze (default: 30)' } },
      },
      handler: async (params) => {
        const allCallers = store.findNodes('ClientSideAPICaller');
        const allEndpoints = store.findNodes('APIEndpoint');
        const stitchedIds = new Set(store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT').map((e) => e.from));
        const unresolved = allCallers.filter((c) => !stitchedIds.has(c.id) && c.urlLiteral && c.egressConfidence !== 'dynamic').slice(0, (params.maxCallers as number) ?? 30);

        const proposals: Array<{ type: string; reasoning: string; rule?: Record<string, unknown>; affectedCallers?: number }> = [];
        const repoCallers = new Map<string, string[]>();
        for (const c of unresolved) {
          const list = repoCallers.get(c.repository) ?? [];
          list.push(c.urlLiteral!);
          repoCallers.set(c.repository, list);
        }

        for (const [repo, urls] of repoCallers) {
          const targetRepos = [...new Set(allEndpoints.map((e) => e.repository))].filter((r) => r !== repo);
          for (const targetRepo of targetRepos) {
            const eps = allEndpoints.filter((e) => e.repository === targetRepo);
            const prefixCounts = new Map<string, number>();
            for (const url of urls) {
              for (const ep of eps) {
                const cp = url.replace(/\/$/, '');
                const ep2 = ep.routePattern.replace(/\/$/, '');
                if (cp.endsWith(ep2) && cp.length > ep2.length) {
                  const prefix = cp.slice(0, cp.length - ep2.length);
                  prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
                }
              }
            }
            for (const [prefix, count] of prefixCounts) {
              if (count >= 2) {
                proposals.push({
                  type: 'rule',
                  reasoning: `${count} callers from "${repo}" have prefix "${prefix}" not on "${targetRepo}" endpoints`,
                  rule: { name: `Strip "${prefix}"`, from: repo, to: targetRepo, transform: { stripPrefix: prefix } },
                  affectedCallers: count,
                });
              }
            }
          }
          const external = urls.filter((u) => u.startsWith('http'));
          if (external.length > 0) {
            proposals.push({ type: 'info', reasoning: `${external.length} callers from "${repo}" are external API calls (https://)`, affectedCallers: external.length });
          }
        }

        return { totalUnresolved: unresolved.length, proposals: proposals.sort((a, b) => (b.affectedCallers ?? 0) - (a.affectedCallers ?? 0)) };
      },
    },

    {
      name: 'add_stitch_rule',
      description: 'Add a URL transformation rule for stitching, scoped to a repo pair',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Rule name' },
          from: { type: 'string', description: 'Source repo (caller)' },
          to: { type: 'string', description: 'Target repo (endpoint)' },
          transformType: { type: 'string', enum: ['stripPrefix', 'addPrefix', 'replacePrefix'] },
          prefix: { type: 'string', description: 'Prefix to strip or add' },
          fromPrefix: { type: 'string', description: 'Prefix to replace (replacePrefix)' },
          toPrefix: { type: 'string', description: 'Replacement (replacePrefix)' },
        },
        required: ['name', 'from', 'to', 'transformType'],
      },
      handler: async (params) => {
        if (!projectConfigPath) throw new Error('Requires --project-config flag');
        const fsSync = await import('node:fs');
        const config = JSON.parse(fsSync.readFileSync(projectConfigPath, 'utf-8'));
        const rules = (config.stitchRules ?? []) as Array<Record<string, unknown>>;
        const transform: Record<string, unknown> = {};
        if (params.transformType === 'stripPrefix') transform.stripPrefix = params.prefix;
        else if (params.transformType === 'addPrefix') transform.addPrefix = params.prefix;
        else if (params.transformType === 'replacePrefix') transform.replacePrefix = { from: params.fromPrefix, to: params.toPrefix };
        rules.push({ name: params.name, from: params.from, to: params.to, transform });
        config.stitchRules = rules;
        fsSync.writeFileSync(projectConfigPath, JSON.stringify(config, null, 2) + '\n');
        return { message: `Rule "${params.name}" added`, rule: rules[rules.length - 1] };
      },
    },

    {
      name: 'apply_stitch_rules',
      description: 'Re-run stitching with transformation rules from the project config',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        if (!projectConfigPath) throw new Error('Requires --project-config flag');
        const fsSync = await import('node:fs');
        const config = JSON.parse(fsSync.readFileSync(projectConfigPath, 'utf-8'));
        const rules = (config.stitchRules ?? []) as Array<{
          name: string; from: string; to: string;
          transform: { stripPrefix?: string; addPrefix?: string; replacePrefix?: { from: string; to: string } };
        }>;
        if (rules.length === 0) return { message: 'No rules defined', newStitches: 0 };

        const callers = store.findNodes('ClientSideAPICaller');
        const endpoints = store.findNodes('APIEndpoint');
        const existingIds = new Set(store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT').map((e) => e.from));
        let newStitches = 0;
        const rulesApplied: string[] = [];

        for (const rule of rules) {
          const ruleCallers = callers.filter((c) => c.repository === rule.from && !existingIds.has(c.id) && c.urlLiteral && c.egressConfidence !== 'dynamic');
          const ruleEndpoints = endpoints.filter((e) => e.repository === rule.to);
          if (ruleCallers.length === 0 || ruleEndpoints.length === 0) continue;

          let applied = false;
          for (const caller of ruleCallers) {
            let url = caller.urlLiteral!;
            if (rule.transform.stripPrefix && url.startsWith(rule.transform.stripPrefix)) url = url.slice(rule.transform.stripPrefix.length);
            else if (rule.transform.addPrefix) url = rule.transform.addPrefix + url;
            else if (rule.transform.replacePrefix && url.startsWith(rule.transform.replacePrefix.from)) url = rule.transform.replacePrefix.to + url.slice(rule.transform.replacePrefix.from.length);

            let adjSegCount = caller.templateSegmentCount ?? null;
            if (adjSegCount !== null && rule.transform.stripPrefix) {
              const stripped = rule.transform.stripPrefix.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean).length;
              adjSegCount = Math.max(1, adjSegCount - stripped);
            }
            let adjParts = caller.templateParts ?? null;
            if (adjParts && rule.transform.stripPrefix && adjParts[0]?.startsWith(rule.transform.stripPrefix)) {
              adjParts = [...adjParts];
              adjParts[0] = adjParts[0].slice(rule.transform.stripPrefix.length);
            }
            const results = matchCallerToEndpoints(
              { id: caller.id, httpMethod: caller.httpMethod, urlLiteral: url, egressConfidence: caller.egressConfidence, templateSpanCount: caller.templateSpanCount ?? null, templateSegmentCount: adjSegCount, templateParts: adjParts },
              ruleEndpoints.map((e) => ({ id: e.id, httpMethod: e.httpMethod, routePattern: e.routePattern }))
            );
            if (results.length > 0 && results[0].matchConfidence === 'high') {
              const topMatches = results.filter((r) => r.matchRank === results[0].matchRank);
              if (topMatches.length === 1) {
                const ep = ruleEndpoints.find((e) => e.id === topMatches[0].endpointId)!;
                store.commit({ nodes: [], edges: [{ edgeType: 'RESOLVES_TO_ENDPOINT' as const, from: caller.id, to: topMatches[0].endpointId, matchedBy: topMatches[0].matchedBy, matchConfidence: topMatches[0].matchConfidence, confirmedBy: 'auto' as const, confirmedAt: new Date().toISOString(), strategy: `rule: ${rule.name}`, fromRepository: caller.repository, toRepository: ep.repository }] }, makeBatchMeta('stitch-rule'));
                existingIds.add(caller.id);
                newStitches++;
                applied = true;
              }
            }
          }
          if (applied) rulesApplied.push(rule.name);
        }
        return { newStitches, rulesApplied };
      },
    },

    {
      name: 'list_orphan_tables',
      description:
        'Find DatabaseTable nodes that no DatabaseInteraction reads or writes. Useful for spotting tables declared in the schema but never queried — either intentional (future feature) or a wiring oversight.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const tableNodes = store.findNodes('DatabaseTable');
        const allReads = store.findEdges(null, null, 'READS');
        const allWrites = store.findEdges(null, null, 'WRITES');
        const touchedTableIds = new Set<string>([
          ...allReads.map((e) => e.to),
          ...allWrites.map((e) => e.to),
        ]);
        const orphans = tableNodes.filter((t) => !touchedTableIds.has(t.id));
        return {
          total: orphans.length,
          totalTables: tableNodes.length,
          tables: orphans.map((t) => ({
            id: t.id,
            name: t.name,
            schema: t.schema,
            kind: t.kind,
            systemId: t.systemId,
          })),
        };
      },
    },

    {
      name: 'stats',
      description: 'Aggregate counts for the entire graph in one call',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const walker = createFlowWalker(store, { maxCallDepth: 10 });
        const flows = walker.walkAllProcesses();
        return {
          sourceFiles: store.findNodes('SourceFile').length,
          functions: store.findNodes('FunctionDefinition').length,
          endpoints: store.findNodes('APIEndpoint').length,
          clientApiCalls: store.findNodes('ClientSideAPICaller').length,
          clientProcesses: store.findNodes('ClientSideProcess').length,
          databaseTables: store.findNodes('DatabaseTable').length,
          databaseInteractions: store.findNodes('DatabaseInteraction').length,
          flows: {
            total: flows.length,
            complete: flows.filter((f) => f.completeness === 'complete').length,
            partial: flows.filter((f) => f.completeness !== 'complete').length,
          },
        };
      },
    },

    {
      name: 'describe_architecture',
      description: 'High-level project overview: endpoint domains, databases, frontend summary',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const endpoints = store.findNodes('APIEndpoint');
        const tables = store.findNodes('DatabaseTable');
        const systems = store.findNodes('DatabaseSystem');
        const processes = store.findNodes('ClientSideProcess');

        const domainMap = new Map<string, { endpoints: number; methods: Set<string> }>();
        for (const ep of endpoints) {
          const parts = ep.routePattern.replace(/^\/+/, '').split('/');
          const prefix = '/' + (parts[0] ?? '');
          const entry = domainMap.get(prefix) ?? { endpoints: 0, methods: new Set() };
          entry.endpoints++;
          entry.methods.add(ep.httpMethod);
          domainMap.set(prefix, entry);
        }

        // External dependencies (#138).
        const callers = store.findNodes('ClientSideAPICaller');
        const extCallers = callers.filter((c) => c.isExternal && c.externalHost);
        const extByHost = new Map<string, { methods: Set<string>; count: number }>();
        for (const c of extCallers) {
          const entry = extByHost.get(c.externalHost ?? '') ?? { methods: new Set(), count: 0 };
          if (c.httpMethod) entry.methods.add(c.httpMethod);
          entry.count++;
          extByHost.set(c.externalHost ?? '', entry);
        }

        return {
          endpointDomains: [...domainMap.entries()]
            .sort((a, b) => b[1].endpoints - a[1].endpoints)
            .map(([prefix, info]) => ({ prefix, endpoints: info.endpoints, methods: [...info.methods] })),
          totalEndpoints: endpoints.length,
          databases: systems.map((s) => ({ name: s.name, kind: s.kind, tables: tables.filter((t) => t.systemId === s.id).length })),
          totalTables: tables.length,
          totalProcesses: processes.length,
          externalDependencies: [...extByHost.entries()].map(([host, info]) => ({
            host, callCount: info.count, methods: [...info.methods].sort(),
          })),
        };
      },
    },

    {
      name: 'impact_analysis',
      description: 'Blast radius analysis: upstream callers + downstream dependencies for an endpoint, table, or file',
      parameters: {
        type: 'object',
        properties: {
          routePattern: { type: 'string', description: 'Route pattern to analyze' },
          tableName: { type: 'string', description: 'Table name to analyze' },
          filePath: { type: 'string', description: 'File path to analyze' },
        },
      },
      handler: async (params) => {
        const walker = createFlowWalker(store, { maxCallDepth: 10 });
        const flows = walker.walkAllProcesses().filter((f) => f.completeness === 'complete');

        if (params.routePattern) {
          const route = params.routePattern as string;
          const affected = flows.filter((f) => f.endpoint?.routePattern === route);
          const tables = [...new Set(affected.flatMap((f) =>
            f.databaseHops.flatMap((h) => [...h.readsTables.map((t) => t.name), ...h.writesTables.map((t) => t.name)])
          ))];
          return {
            endpoint: route,
            affectedFlowCount: affected.length,
            calledBy: affected.map((f) => f.startProcess.name),
            touchesTables: tables,
          };
        }
        if (params.tableName) {
          const table = params.tableName as string;
          const affected = flows.filter((f) =>
            f.databaseHops.some((h) => h.readsTables.some((t) => t.name === table) || h.writesTables.some((t) => t.name === table))
          );
          return {
            table,
            affectedFlowCount: affected.length,
            endpoints: [...new Set(affected.map((f) => `${f.endpoint?.httpMethod} ${f.endpoint?.routePattern}`))],
          };
        }
        if (params.filePath) {
          const fp = params.filePath as string;
          const allFlows = walker.walkAllProcesses();
          const affected = allFlows.filter((f) => {
            const nodes = [f.startProcess, f.caller, f.endpoint, f.handlerFunction].filter(Boolean);
            return nodes.some((n) => {
              if (!n) return false;
              if ('evidence' in n && n.evidence && (n.evidence as { filePath?: string }).filePath === fp) return true;
              if ('sourceFileId' in n) {
                const sf = store.getNode('SourceFile', (n as { sourceFileId: string }).sourceFileId);
                return sf?.filePath === fp;
              }
              return false;
            });
          });
          return {
            file: fp,
            affectedFlowCount: affected.length,
            flows: affected.slice(0, 20).map((f) => ({
              process: f.startProcess.name,
              endpoint: f.endpoint ? `${f.endpoint.httpMethod} ${f.endpoint.routePattern}` : null,
              completeness: f.completeness,
            })),
          };
        }
        throw new Error('Provide routePattern, tableName, or filePath');
      },
    },

    {
      name: 'diff_flows',
      description: 'Given changed file paths, return all affected flows. Useful for PR reviews.',
      parameters: {
        type: 'object',
        properties: {
          changedFiles: { type: 'array', items: { type: 'string' }, description: 'Changed file paths' },
        },
        required: ['changedFiles'],
      },
      handler: async (params) => {
        const files = new Set(params.changedFiles as string[]);
        const walker = createFlowWalker(store, { maxCallDepth: 10 });
        const allFlows = walker.walkAllProcesses();
        const affected = allFlows.filter((f) => {
          const nodes = [f.startProcess, f.caller, f.endpoint, f.handlerFunction].filter(Boolean);
          return nodes.some((n) => {
            if (!n) return false;
            if ('evidence' in n && n.evidence && files.has(n.evidence.filePath)) return true;
            if ('sourceFileId' in n) {
              const sf = store.getNode('SourceFile', (n as { sourceFileId: string }).sourceFileId);
              return sf ? files.has(sf.filePath) : false;
            }
            return false;
          });
        });
        return {
          changedFiles: [...files],
          affectedFlowCount: affected.length,
          flows: affected.map((f) => ({
            process: f.startProcess.name,
            endpoint: f.endpoint ? `${f.endpoint.httpMethod} ${f.endpoint.routePattern}` : null,
            completeness: f.completeness,
          })),
        };
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function formatServiceHopsRest(hops: Array<{ caller: any; endpoint: any; handlerFunction: any; repository: string; databaseHops: any[]; downstreamCalls: any[] }>): unknown[] {
  return hops.map((hop) => ({
    repository: hop.repository,
    caller: { httpMethod: hop.caller.httpMethod, urlLiteral: hop.caller.urlLiteral },
    endpoint: { httpMethod: hop.endpoint.httpMethod, routePattern: hop.endpoint.routePattern, framework: hop.endpoint.framework },
    handlerFunction: hop.handlerFunction ? { name: hop.handlerFunction.name } : null,
    databaseHops: hop.databaseHops.map((dbHop: any) => ({ operation: dbHop.interaction.operation, orm: dbHop.interaction.orm, readsTables: dbHop.readsTables.map((t: any) => t.name), writesTables: dbHop.writesTables.map((t: any) => t.name) })),
    downstreamCalls: hop.downstreamCalls.length > 0 ? formatServiceHopsRest(hop.downstreamCalls) : [],
  }));
}


/**
 * #339 — Lazy SourceFile index keyed on the store instance. The
 * REST server is read-only after the DB is built, so building this
 * once on first `get_source_file` filePath lookup is safe and
 * eliminates the per-call `findNodes('SourceFile')` SQLite scan.
 *
 * Exact-match lookups become O(1); substring lookups remain O(n)
 * but iterate the cached Map values instead of round-tripping to
 * SQLite each call. Same behavior regardless of graph size.
 */
const sourceFileIndexCache = new WeakMap<
  object,
  { byExactPath: Map<string, Extract<SchemaNode, { nodeType: 'SourceFile' }>> }
>();

function getSourceFileIndex(store: CanonicalGraphStore): {
  byExactPath: Map<string, Extract<SchemaNode, { nodeType: 'SourceFile' }>>;
} {
  const cached = sourceFileIndexCache.get(store as object);
  if (cached) return cached;
  const byExactPath = new Map<string, Extract<SchemaNode, { nodeType: 'SourceFile' }>>();
  for (const sf of store.findNodes('SourceFile')) {
    byExactPath.set(sf.filePath, sf);
  }
  const built = { byExactPath };
  sourceFileIndexCache.set(store as object, built);
  return built;
}
