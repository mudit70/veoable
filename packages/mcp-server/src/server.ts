import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CanonicalGraphStore } from '@veoable/graph-db';
import { makeBatchMeta } from '@veoable/plugin-api';
import {
  FLOW_STITCHER_PRODUCER_ID,
  createFlowWalker,
  matchCallerToEndpoints,
  stitchStore,
  buildApplicationScope,
  type Application,
  type ApplicationScope,
  type Flow,
  type ServiceHop,
} from '@veoable/flow-stitcher';
import { EDGE_TYPES } from '@veoable/schema';
import type {
  NodeType,
  EdgeType,
  SchemaNode,
} from '@veoable/schema';
import { getSkillMarkdown } from '@veoable/skill';

/**
 * Create an MCP server wired to a canonical graph store.
 *
 * The server exposes tools for querying the Adorable knowledge graph
 * — both raw graph primitives (`list_nodes`, `get_node`, `find_edges`)
 * and high-level flow operations (`walk_flows`, `walk_all_flows`,
 * `stitch`). An AI agent connected via the MCP protocol can ask
 * natural-language questions about the codebase; the client translates
 * those into tool calls and synthesizes answers from the structured
 * responses.
 *
 * The server is a pure data server. It never calls an AI provider.
 * It reads from the pre-populated canonical store and returns
 * structured JSON. The AI reasoning happens entirely on the client
 * side.
 */
export interface McpServerOptions {
  /** Absolute path to the analyzed project root. Required for get_source_file. */
  projectRoot?: string;
  /** Path to project config file. Required for stitch rules. */
  projectConfigPath?: string;
  /** Project name. Auto-read from projectConfigPath if not provided. Falls back to dbPath basename. */
  projectName?: string;
  /** Path to the database file. Used to derive project name if not otherwise available. */
  dbPath?: string;
}

export function createMcpServer(store: CanonicalGraphStore, opts?: McpServerOptions) {
  const projectRoot = opts?.projectRoot;
  const projectConfigPath = opts?.projectConfigPath;

  // Resolve project name: explicit option → config file → DB filename → null.
  let projectName: string | null = opts?.projectName ?? null;
  if (!projectName && projectConfigPath) {
    try {
      const config = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
      projectName = config.name ?? null;
    } catch { /* ignore — config may not exist yet */ }
  }
  if (!projectName && opts?.dbPath) {
    projectName = path.basename(opts.dbPath, path.extname(opts.dbPath));
  }

  const server = new McpServer({
    name: 'veoable',
    version: '0.1.0',
  });

  // #291 — in-session memoization for add_stitch_rule dryRun previews.
  // Tracks canonical (from, to, transform) keys for rules previewed
  // via dryRun in THIS server session. Lets the agent distinguish
  // "first time previewing this proposal" from "I already previewed
  // this earlier in the session." Cleared when the server restarts.
  // Bounded with FIFO eviction so a long-lived autonomous-agent session
  // can't leak unbounded memory.
  const DRY_RUN_PREVIEW_MAX = 1000;
  const dryRunPreviewedKeys = new Map<string, { ruleName: string; previewedAt: string }>();

  // #274 + #277 — uniform error response shape. Every tool that
  // detects bad input returns isError:true with a JSON-encoded
  // {error, code, hint?} body. Empty results on valid input are
  // distinct: no isError, success-shaped payload (empty array, etc.).
  const errorResponse = (
    message: string,
    code: 'NOT_FOUND' | 'INVALID_INPUT' | 'PRECONDITION_FAILED',
    hint?: string,
  ) => ({
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(hint ? { error: message, code, hint } : { error: message, code }, null, 2) }],
  });

  // #255 — re-load the project's `applications` declaration on every
  // stitch so MCP-driven stitching honors the same app-pair scope the
  // CLI used. Without this, MCP `stitch` / `auto_stitch` would commit
  // cross-app RESOLVES_TO_ENDPOINT edges that the CLI explicitly
  // suppressed, silently undoing the invariant.
  const loadApplicationScope = (): ApplicationScope | undefined => {
    try {
      const raw = store.getMeta?.('applications');
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Application[];
      if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
      return buildApplicationScope(parsed);
    } catch {
      return undefined;
    }
  };

  // ──────────────────────────────────────────────────────────────────
  // Summary tools (#118)
  // ──────────────────────────────────────────────────────────────────

  // #363 — `describe_skill` returns the canonical SKILL.md so an
  // agent can re-orient mid-session without restarting. Lives next
  // to the other orientation tools because conceptually it's the
  // most foundational: it tells the agent *which* question shapes
  // map to *which* tool sequences. Per-client adapters embed the
  // same content at install time; this tool is the runtime
  // self-introspection path for agents that didn't get it embedded.
  server.tool(
    'describe_skill',
    "Return the canonical Adorable skill description (SKILL.md): when to invoke Adorable tools, when not to, and the recommended tool chains for common questions. Call this once at session start if you don't already have the Adorable skill loaded, if you're unsure whether a question should be answered with Adorable, or if you need a refresher on which tool fits which question shape.",
    {},
    async () => {
      return {
        content: [
          { type: 'text' as const, text: getSkillMarkdown() },
        ],
      };
    }
  );

  server.tool(
    'list_repositories',
    'Return the project name and all repositories in the knowledge graph with per-repo node counts. Call this first to understand what project and repos are available.',
    {},
    async () => {
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
        for (const s of store.findNodes('Screen', { repository: r.repository } as any)) {
          if (s.framework) frameworks.add(s.framework);
        }
        return { ...r, languages, frameworks: [...frameworks].sort() };
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ...(projectName ? { project: projectName } : {}),
          repositories: enriched,
        }, null, 2) }],
      };
    }
  );

  server.tool(
    'stats',
    'Return aggregate counts for the entire knowledge graph, or scoped to a single repository. The most token-efficient way to answer "how many X?" questions.',
    {
      repository: z.string().optional().describe('Filter stats to a single repository (use list_repositories to see available repos)'),
    },
    async ({ repository }) => {
      const repoFilter = repository ? { repository } as Record<string, unknown> : undefined;

      const walker = createFlowWalker(store, { maxCallDepth: 10 });
      let flows = walker.walkAllProcesses();
      if (repository) {
        flows = flows.filter((f) => f.startProcess.repository === repository);
      }
      const completeFlows = flows.filter((f) => f.completeness === 'complete');
      const stitchEdges = store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...(projectName ? { project: projectName } : {}),
              ...(repository ? { repository } : {}),
              sourceFiles: store.findNodes('SourceFile', repoFilter as any).length,
              functions: repository
                ? store.findNodes('SourceFile', repoFilter as any)
                    .reduce((sum, sf) => sum + store.findEdges(null, sf.id, 'DEFINED_IN').length, 0)
                : store.findNodes('FunctionDefinition').length,
              endpoints: store.findNodes('APIEndpoint', repoFilter as any).length,
              clientApiCalls: store.findNodes('ClientSideAPICaller', repoFilter as any).length,
              clientProcesses: store.findNodes('ClientSideProcess', repoFilter as any).length,
              screens: store.findNodes('Screen', repoFilter as any).length,
              environmentVariables: store.findNodes('EnvironmentVariable' as NodeType, repoFilter as any).length,
              databaseSystems: store.findNodes('DatabaseSystem').length,
              databaseTables: store.findNodes('DatabaseTable').length,
              databaseInteractions: store.findNodes('DatabaseInteraction').length,
              flows: {
                total: flows.length,
                complete: completeFlows.length,
                partial: flows.length - completeFlows.length,
              },
              stitches: {
                total: repository
                  ? stitchEdges.filter((e) => {
                      const caller = store.getNode('ClientSideAPICaller', e.from);
                      return caller?.repository === repository;
                    }).length
                  : stitchEdges.length,
              },
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'describe_architecture',
    'Return a high-level overview of the project architecture: endpoint domains grouped by route prefix, database tables, and frontend component summary. ~500 tokens.',
    {
      repository: z.string().optional().describe('Scope to a single repository'),
    },
    async ({ repository }) => {
      const repoFilter = repository ? { repository } as any : undefined;
      const endpoints = store.findNodes('APIEndpoint', repoFilter);
      const tables = store.findNodes('DatabaseTable');
      const systems = store.findNodes('DatabaseSystem');
      const callers = store.findNodes('ClientSideAPICaller', repoFilter);
      const processes = store.findNodes('ClientSideProcess', repoFilter);
      const sourceFiles = store.findNodes('SourceFile', repoFilter);
      const screenNodes = store.findNodes('Screen', repoFilter);

      // Group endpoints by first path segment as domain.
      const domainMap = new Map<string, { endpoints: number; methods: Set<string>; files: Set<string> }>();
      for (const ep of endpoints) {
        const parts = ep.routePattern.replace(/^\/+/, '').split('/');
        const prefix = '/' + (parts[0] ?? '');
        const entry = domainMap.get(prefix) ?? { endpoints: 0, methods: new Set(), files: new Set() };
        entry.endpoints++;
        entry.methods.add(ep.httpMethod);
        if (ep.evidence?.filePath) entry.files.add(ep.evidence.filePath);
        domainMap.set(prefix, entry);
      }

      const domains = [...domainMap.entries()]
        .sort((a, b) => b[1].endpoints - a[1].endpoints)
        .map(([prefix, info]) => ({
          prefix,
          endpoints: info.endpoints,
          methods: [...info.methods].sort(),
          files: [...info.files],
        }));

      // Database summary.
      const databases = systems.map((s) => ({
        name: s.name,
        kind: s.kind,
        tables: tables.filter((t) => t.systemId === s.id).length,
      }));

      // Frontend summary.
      const processKinds: Record<string, number> = {};
      for (const p of processes) {
        processKinds[p.kind] = (processKinds[p.kind] ?? 0) + 1;
      }
      const screensByNavigator: Record<string, number> = {};
      for (const s of screenNodes) {
        // navigatorKind is optional post-#198 PR1 — SSG/SSR pages have
        // no navigator concept. Bucket those under '<none>'.
        const kind = s.navigatorKind ?? '<none>';
        screensByNavigator[kind] = (screensByNavigator[kind] ?? 0) + 1;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              endpointDomains: domains,
              totalEndpoints: endpoints.length,
              databases,
              totalTables: tables.length,
              frontend: {
                sourceFiles: sourceFiles.length,
                apiCalls: callers.length,
                processes: processes.length,
                processByKind: processKinds,
                screens: screenNodes.length,
                screensByNavigator,
              },
              externalDependencies: (() => {
                const extCallers = callers.filter((c) => c.isExternal && c.externalHost);
                const byHost = new Map<string, { methods: Set<string>; count: number }>();
                for (const c of extCallers) {
                  const entry = byHost.get(c.externalHost ?? '') ?? { methods: new Set(), count: 0 };
                  if (c.httpMethod) entry.methods.add(c.httpMethod);
                  entry.count++;
                  byHost.set(c.externalHost ?? '', entry);
                }
                return [...byHost.entries()].map(([host, info]) => ({
                  host, callCount: info.count, methods: [...info.methods].sort(),
                }));
              })(),
            }, null, 2),
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // Graph query tools
  // ──────────────────────────────────────────────────────────────────

  server.tool(
    'list_nodes',
    'List nodes in the knowledge graph by type, with optional property filters. Evidence is excluded by default to keep responses small — pass includeEvidence: true to include source code snippets.',
    {
      nodeType: z
        .enum([
          'SourceFile',
          'FunctionDefinition',
          'APIEndpoint',
          'ClientSideAPICaller',
          'ClientSideProcess',
          'DatabaseSystem',
          'DatabaseTable',
          'DatabaseColumn',
          'DatabaseInteraction',
          'Screen',
          'EnvironmentVariable',
        ])
        .describe('The node type to list'),
      filter: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe('Optional key-value property filter (AND semantics)'),
      limit: z.number().optional().describe('Max number of results (default: all)'),
      offset: z.number().optional().describe('Skip this many results (default: 0)'),
      countOnly: z.boolean().optional().describe('Return only the count, no node data (default: false)'),
      includeEvidence: z.boolean().optional().describe('Include source code evidence snippets (default: false)'),
      fields: z.array(z.string()).optional().describe('Only include these properties on each node (e.g., ["httpMethod", "routePattern"])'),
    },
    async ({ nodeType, filter, limit, offset, countOnly, includeEvidence, fields }) => {
      let nodes = store.findNodes(
        nodeType as NodeType,
        filter as Partial<SchemaNode> | undefined
      );
      const total = nodes.length;

      if (countOnly) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ total }, null, 2) }],
        };
      }

      if (limit != null || offset != null) {
        const off = offset ?? 0;
        const lim = limit ?? total;
        nodes = nodes.slice(off, off + lim);
      }

      let data: unknown[];
      if (fields && fields.length > 0) {
        // Project only requested fields (always include id and nodeType).
        const fieldSet = new Set(['id', 'nodeType', ...fields]);
        data = nodes.map((n) => {
          const result: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(n)) {
            if (fieldSet.has(key)) result[key] = value;
          }
          return result;
        });
      } else {
        data = includeEvidence ? nodes : nodes.map((n) => stripVerboseFields(n)) as unknown[];
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ total, nodes: data }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'get_node',
    'Get a single node by its type and content-addressed id. Pass includeEvidence: true to include source code snippets.',
    {
      nodeType: z
        .enum([
          'SourceFile',
          'FunctionDefinition',
          'APIEndpoint',
          'ClientSideAPICaller',
          'ClientSideProcess',
          'DatabaseSystem',
          'DatabaseTable',
          'DatabaseColumn',
          'DatabaseInteraction',
          'Screen',
        ])
        .describe('The node type'),
      id: z.string().describe('The content-addressed node id'),
      includeEvidence: z.boolean().optional().describe('Include source code evidence (default: false)'),
    },
    async ({ nodeType, id, includeEvidence }) => {
      const node = store.getNode(nodeType as NodeType, id);
      if (!node) {
        return errorResponse(
          `${nodeType} id not found: ${id}`,
          'NOT_FOUND',
          `Use list_nodes type=${nodeType} to find valid ids.`,
        );
      }
      const data = includeEvidence ? node : stripVerboseFields(node);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    }
  );

  server.tool(
    'find_edges',
    'Find edges by source node id, target node id, and/or edge type. All filters are optional — pass any combination (e.g. just `edgeType` for "all edges of this type"); omit `from`/`to` (or pass null) to wildcard.',
    {
      from: z.string().nullable().optional().describe('Source node id; omit or null to wildcard'),
      to: z.string().nullable().optional().describe('Target node id; omit or null to wildcard'),
      // #290 — derive the enum from the canonical schema list so MCP
      // and the schema can't drift apart as new edge types are added.
      edgeType: z
        .enum([...EDGE_TYPES] as [EdgeType, ...EdgeType[]])
        .optional()
        .describe('Optional edge type filter'),
    },
    async ({ from, to, edgeType }) => {
      const edges = store.findEdges(
        from ?? null,
        to ?? null,
        edgeType as EdgeType | undefined
      );
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(edges, null, 2) },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // Flow tools
  // ──────────────────────────────────────────────────────────────────

  server.tool(
    'walk_flows',
    'Walk end-to-end flows starting from a specific ClientSideProcess. Evidence excluded by default — pass includeEvidence: true for source snippets.',
    {
      processId: z
        .string()
        .describe('The id of the ClientSideProcess to start walking from'),
      maxCallDepth: z
        .number()
        .optional()
        .describe('Max call-graph traversal depth (default: 10)'),
      includeEvidence: z.boolean().optional().describe('Include source code evidence (default: false)'),
      maxHops: z.number().optional().describe('Max service-to-service hops (default: 1). Set to 2+ for microservice architectures.'),
    },
    async ({ processId, maxCallDepth, includeEvidence, maxHops }) => {
      // #274 — fail-fast on bogus process id so typos don't look like
      // genuine empty results. Narrow to ClientSideProcess so a
      // mistakenly-passed APIEndpoint id surfaces as NOT_FOUND, not
      // as a silent empty result.
      if (!store.getNode('ClientSideProcess', processId)) {
        return errorResponse(
          `ClientSideProcess id not found: ${processId}`,
          'NOT_FOUND',
          'Use list_nodes type=ClientSideProcess or describe_screen to find valid process ids.',
        );
      }
      const walker = createFlowWalker(store, {
        maxCallDepth: maxCallDepth ?? 10,
        maxHops: maxHops ?? 1,
      });
      const flows = walker.walkFromProcess(processId);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatFlows(flows, includeEvidence ?? false), null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'walk_all_flows',
    'Walk end-to-end flows for every ClientSideProcess. Supports countOnly, completeness filter, and filters by table/endpoint/file.',
    {
      maxCallDepth: z.number().optional().describe('Max call-graph traversal depth (default: 10)'),
      includeEvidence: z.boolean().optional().describe('Include source code evidence (default: false)'),
      countOnly: z.boolean().optional().describe('Return only the count of flows (default: false)'),
      completenessFilter: z.enum(['complete', 'process-only', 'function-only', 'caller-only', 'endpoint-only', 'handler-only']).optional().describe('Only return flows with this completeness level'),
      filterByTable: z.string().optional().describe('Only flows that read/write this table name'),
      filterByEndpoint: z.string().optional().describe('Only flows matching this route pattern prefix'),
      filterByFile: z.string().optional().describe('Only flows involving this source file path'),
      repository: z.string().optional().describe('Only flows originating from this repository'),
      filterByProcessKind: z.enum(['event_handler', 'lifecycle_hook', 'state_observer', 'timer', 'browser_event', 'cli_command', 'script_entry', 'bridge_command', 'ui_action', 'other']).optional().describe('Only flows starting from processes of this kind (e.g., "lifecycle_hook" for app launch flows, "event_handler" for user-triggered flows)'),
      maxHops: z.number().optional().describe('Max service-to-service hops (default: 1). Set to 2+ for microservice architectures.'),
    },
    async ({ maxCallDepth, includeEvidence, countOnly, completenessFilter, filterByTable, filterByEndpoint, filterByFile, repository, filterByProcessKind, maxHops }) => {
      const walker = createFlowWalker(store, {
        maxCallDepth: maxCallDepth ?? 10,
        maxHops: maxHops ?? 1,
      });
      let flows = walker.walkAllProcesses();

      if (repository) {
        flows = flows.filter((f) => f.startProcess.repository === repository);
      }
      if (filterByProcessKind) {
        flows = flows.filter((f) => f.startProcess.kind === filterByProcessKind);
      }

      // Apply filters.
      if (completenessFilter) {
        flows = flows.filter((f) => f.completeness === completenessFilter);
      }
      if (filterByTable) {
        const tableName = filterByTable;
        flows = flows.filter((f) =>
          flowTouchesTable(f, tableName)
        );
      }
      if (filterByEndpoint) {
        const prefix = filterByEndpoint;
        flows = flows.filter((f) =>
          f.endpoint?.routePattern?.startsWith(prefix)
        );
      }
      if (filterByFile) {
        const filePath = filterByFile;
        flows = flows.filter((f) => {
          const nodes = [f.startProcess, f.caller, f.endpoint, f.handlerFunction].filter(Boolean);
          return nodes.some((n) => {
            if (!n) return false;
            if ('evidence' in n && n.evidence?.filePath === filePath) return true;
            if ('sourceFileId' in n) {
              const sf = store.getNode('SourceFile', (n as { sourceFileId: string }).sourceFileId);
              return sf?.filePath === filePath;
            }
            return false;
          });
        });
      }

      if (countOnly) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ total: flows.length }, null, 2) }],
        };
      }

      // #276 — strip per-entry. Complete flows keep all their fields;
      // incomplete-subset entries shed the deterministic-null bloat.
      const formatted = formatFlows(flows, includeEvidence ?? false).map((f) => stripNullishFields(f));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatted, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'stitch',
    'Run the URL stitcher to emit RESOLVES_TO_ENDPOINT edges linking ClientSideAPICallers to APIEndpoints. Safe to call multiple times — idempotent via content-addressed edge dedup.',
    {},
    async () => {
      const batch = stitchStore(store, { applicationScope: loadApplicationScope() });
      store.commit(batch, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                edgesEmitted: batch.edges.length,
                message:
                  batch.edges.length > 0
                    ? `Stitched ${batch.edges.length} RESOLVES_TO_ENDPOINT edge(s)`
                    : 'No new edges to stitch (all callers already resolved or dynamic)',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // Stitching tools (#101)
  // ──────────────────────────────────────────────────────────────────

  server.tool(
    'stitch_report',
    'Comprehensive stitching report: what was stitched and why, what was not and why not. Diagnoses prefix mismatches and suggests rules.',
    {},
    async () => {
      const callers = store.findNodes('ClientSideAPICaller');
      const endpoints = store.findNodes('APIEndpoint');

      const stitched: Array<{
        caller: string; callerRepo: string; endpoint: string; endpointRepo: string;
        strategy: string; confidence: string;
      }> = [];
      const unresolved: Array<{
        caller: string; callerRepo: string; url: string; method: string | null;
        candidates: Array<{ endpoint: string; repo: string; issue: string }>;
        suggestedRule: string | null;
      }> = [];
      const dynamic: Array<Record<string, unknown>> = [];
      const external: Array<{ host: string; httpMethod: string | null; url: string; repo: string; sourceFile: string | null }> = [];

      // Gather all existing stitches.
      const allStitchEdges = store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT');
      const stitchedCallerIds = new Set(allStitchEdges.map((e) => e.from));

      for (const edge of allStitchEdges) {
        const caller = store.getNode('ClientSideAPICaller', edge.from);
        const ep = store.getNode('APIEndpoint', edge.to);
        if (caller && ep) {
          stitched.push({
            caller: `${caller.httpMethod ?? '?'} ${caller.urlLiteral ?? '<dynamic>'}`,
            callerRepo: caller.repository,
            endpoint: `${ep.httpMethod} ${ep.routePattern}`,
            endpointRepo: ep.repository,
            strategy: (edge as Record<string, unknown>).matchedBy as string ?? 'unknown',
            confidence: (edge as Record<string, unknown>).matchConfidence as string ?? 'unknown',
          });
        }
      }

      // Analyze unresolved callers.
      const matcherEndpoints = endpoints.map((e) => ({
        id: e.id, httpMethod: e.httpMethod, routePattern: e.routePattern,
      }));

      for (const caller of callers) {
        if (stitchedCallerIds.has(caller.id)) continue;

        // Separate external API calls (#138).
        if (caller.isExternal && caller.externalHost) {
          const sourceFile = store.getNode('SourceFile', caller.sourceFileId);
          external.push({
            host: caller.externalHost,
            httpMethod: caller.httpMethod,
            url: caller.urlLiteral ?? '<dynamic>',
            repo: caller.repository,
            sourceFile: sourceFile?.filePath ?? null,
          });
          continue;
        }

        if (caller.urlLiteral === null || caller.egressConfidence === 'dynamic') {
          // Include enough context for a human/AI to reason about the caller.
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

        // Find candidates and diagnose why they didn't match.
        const candidates: Array<{ endpoint: string; repo: string; issue: string }> = [];
        const callerUrl = caller.urlLiteral;
        const callerMethod = caller.httpMethod;

        for (const ep of endpoints) {
          if (callerMethod && ep.httpMethod !== callerMethod) continue;

          // Check for prefix mismatch.
          const callerPath = callerUrl.replace(/\/$/, '');
          const epPath = ep.routePattern.replace(/\/$/, '');

          if (callerPath === epPath) {
            candidates.push({ endpoint: `${ep.httpMethod} ${ep.routePattern}`, repo: ep.repository, issue: 'should-match' });
          } else if (callerPath.endsWith(epPath) || epPath.endsWith(callerPath)) {
            const diff = callerPath.length > epPath.length
              ? callerPath.slice(0, callerPath.length - epPath.length)
              : epPath.slice(0, epPath.length - callerPath.length);
            candidates.push({
              endpoint: `${ep.httpMethod} ${ep.routePattern}`,
              repo: ep.repository,
              issue: `prefix-mismatch: "${diff}"`,
            });
          } else {
            // Check if the static prefix of the caller matches the start of the route.
            const callerPrefix = callerUrl.replace(/\/$/, '');
            if (ep.routePattern.startsWith(callerPrefix) || callerPrefix.startsWith(ep.routePattern.split('/:')[0])) {
              candidates.push({
                endpoint: `${ep.httpMethod} ${ep.routePattern}`,
                repo: ep.repository,
                issue: 'segment-or-pattern-mismatch',
              });
            }
          }
        }

        // Detect common prefix pattern for rule suggestion.
        let suggestedRule: string | null = null;
        const prefixMismatches = candidates.filter((c) => c.issue.startsWith('prefix-mismatch'));
        if (prefixMismatches.length > 0) {
          const prefixes = prefixMismatches.map((c) => {
            const match = c.issue.match(/prefix-mismatch: "(.+)"/);
            return match ? match[1] : null;
          }).filter(Boolean);
          if (prefixes.length > 0) {
            const commonPrefix = prefixes[0];
            if (prefixes.every((p) => p === commonPrefix)) {
              suggestedRule = `stripPrefix "${commonPrefix}" (from ${caller.repository} to ${candidates[0]?.repo ?? '?'})`;
            }
          }
        }

        if (candidates.length > 0 || suggestedRule) {
          unresolved.push({
            caller: caller.id,
            callerRepo: caller.repository,
            url: `${caller.httpMethod ?? '?'} ${caller.urlLiteral}`,
            method: caller.httpMethod,
            candidates: candidates.slice(0, 5), // Limit candidates
            suggestedRule,
          });
        }
      }

      // Detect global prefix pattern across all unresolved callers.
      const allSuggestedPrefixes = unresolved
        .map((u) => u.suggestedRule)
        .filter(Boolean);
      const prefixCounts: Record<string, number> = {};
      for (const rule of allSuggestedPrefixes) {
        prefixCounts[rule!] = (prefixCounts[rule!] ?? 0) + 1;
      }
      const topSuggestedRule = Object.entries(prefixCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([rule, count]) => ({ rule, count }))[0] ?? null;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: {
              stitched: stitched.length,
              unresolved: unresolved.length,
              dynamic: dynamic.length,
              external: external.length,
              totalCallers: callers.length,
            },
            topSuggestedRule,
            stitched: stitched.slice(0, 10), // Show first 10
            unresolved: unresolved.slice(0, 15), // Show first 15
            dynamic,
            // Group external calls by host.
            externalByHost: Object.entries(
              external.reduce<Record<string, typeof external>>((acc, e) => {
                (acc[e.host] ??= []).push(e);
                return acc;
              }, {})
            ).map(([host, calls]) => ({
              host,
              callCount: calls.length,
              methods: [...new Set(calls.map((c) => c.httpMethod).filter(Boolean))],
            })),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'add_stitch_rule',
    'Add a URL transformation rule for stitching. Rules are scoped to a from/to repo pair and stored in the project config file. Requires --project-config on serve. Pass dryRun:true to preview without writing. Idempotent — calling with the same args twice is a no-op.',
    {
      name: z.string().describe('Human-readable rule name'),
      from: z.string().describe('Source repo name (caller side)'),
      to: z.string().describe('Target repo name (endpoint side)'),
      transformType: z.enum(['stripPrefix', 'addPrefix', 'replacePrefix']).describe('Transform type'),
      prefix: z.string().optional().describe('Prefix to strip or add'),
      fromPrefix: z.string().optional().describe('Prefix to replace (for replacePrefix)'),
      toPrefix: z.string().optional().describe('Replacement prefix (for replacePrefix)'),
      dryRun: z.boolean().optional().describe('Preview the rule that would be added without writing to disk (default: false)'),
    },
    async ({ name: ruleName, from: fromRepo, to: toRepo, transformType, prefix, fromPrefix, toPrefix, dryRun }) => {
      if (!projectConfigPath) {
        return errorResponse(
          'add_stitch_rule requires --project-config on the serve command',
          'PRECONDITION_FAILED',
        );
      }

      const fs = await import('node:fs');
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
      } catch {
        return errorResponse(
          `Cannot read project config: ${projectConfigPath}`,
          'PRECONDITION_FAILED',
        );
      }

      const rules = (config.stitchRules ?? []) as Array<Record<string, unknown>>;
      const transform: Record<string, unknown> = {};
      if (transformType === 'stripPrefix') transform.stripPrefix = prefix;
      else if (transformType === 'addPrefix') transform.addPrefix = prefix;
      else if (transformType === 'replacePrefix') transform.replacePrefix = { from: fromPrefix, to: toPrefix };

      const newRule = { name: ruleName, from: fromRepo, to: toRepo, transform };

      // #273 — dedup by (from, to, transform) tuple. Identity uses a
      // canonical JSON of the transform that recursively sorts object
      // keys, so two transforms with identical contents in different
      // key order still match. The replacer-array form of
      // JSON.stringify (`JSON.stringify(v, ['k1', 'k2'])`) filters
      // keys at EVERY nesting level, which would drop the inner
      // {from, to} of a replacePrefix transform — broken for the
      // common case. Hand-roll the canonical form instead.
      // Name is deliberately NOT part of identity: the user can rename
      // a rule without producing a duplicate.
      const canonical = (v: unknown): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(canonical);
        const entries = Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, canonical(val)] as const);
        return Object.fromEntries(entries);
      };
      const transformKey = JSON.stringify(canonical(transform));
      const existing = rules.find((r) =>
        r.from === fromRepo &&
        r.to === toRepo &&
        JSON.stringify(canonical(r.transform)) === transformKey,
      );
      if (existing) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'Rule already exists; no change made.',
              existingRule: existing,
            }, null, 2),
          }],
        };
      }

      // #273 — dryRun returns the rule without writing.
      // #291 — in-session memoization. The persistence-state dedup
      // above already handles "rule exists in config" case. This
      // additional check distinguishes "I already previewed this
      // exact rule earlier in this server session" so a repeat dryRun
      // produces a distinguishable response instead of the same
      // generic "would add" — useful diagnostic for agents reviewing
      // their own tool log.
      if (dryRun) {
        // Build the same identity key used by the persistence dedup.
        const sessionKey = `${fromRepo}|${toRepo}|${transformKey}`;
        const previousPreview = dryRunPreviewedKeys.get(sessionKey);
        if (previousPreview) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                message: 'Dry-run: identical to a rule you previewed earlier in this session — no rewrite needed.',
                wouldAdd: newRule,
                previousPreview: previousPreview,
              }, null, 2),
            }],
          };
        }
        // FIFO eviction when at cap. Map iteration is insertion-order
        // in JS, so the first key is the oldest.
        if (dryRunPreviewedKeys.size >= DRY_RUN_PREVIEW_MAX) {
          const firstKey = dryRunPreviewedKeys.keys().next().value;
          if (firstKey !== undefined) dryRunPreviewedKeys.delete(firstKey);
        }
        dryRunPreviewedKeys.set(sessionKey, {
          ruleName,
          previewedAt: new Date().toISOString(),
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'Dry-run: rule would be added.',
              wouldAdd: newRule,
            }, null, 2),
          }],
        };
      }

      rules.push(newRule);
      config.stitchRules = rules;
      fs.writeFileSync(projectConfigPath, JSON.stringify(config, null, 2) + '\n');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Rule "${ruleName}" added`, rule: newRule }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'apply_stitch_rules',
    'Re-run stitching with transformation rules from the project config applied. Transforms caller URLs per rule before matching against endpoints.',
    {},
    async () => {
      if (!projectConfigPath) {
        return { content: [{ type: 'text' as const, text: 'Requires --project-config flag on serve command' }], isError: true };
      }

      const fs = await import('node:fs');
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
      } catch {
        return { content: [{ type: 'text' as const, text: `Cannot read project config: ${projectConfigPath}` }], isError: true };
      }

      const rules = (config.stitchRules ?? []) as Array<{
        name: string; from: string; to: string;
        transform: { stripPrefix?: string; addPrefix?: string; replacePrefix?: { from: string; to: string } };
      }>;

      if (rules.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'No stitch rules defined', newStitches: 0 }) }] };
      }

      const callers = store.findNodes('ClientSideAPICaller');
      const endpoints = store.findNodes('APIEndpoint');
      const existingStitchIds = new Set(
        store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT').map((e) => e.from)
      );

      const matcherEndpoints = endpoints.map((e) => ({
        id: e.id, httpMethod: e.httpMethod, routePattern: e.routePattern, repository: e.repository,
      }));

      let newStitchCount = 0;
      const rulesApplied: string[] = [];

      for (const rule of rules) {
        const ruleCallers = callers.filter((c) =>
          c.repository === rule.from && !existingStitchIds.has(c.id) &&
          c.urlLiteral !== null && c.egressConfidence !== 'dynamic'
        );
        const ruleEndpoints = matcherEndpoints.filter((e) => e.repository === rule.to);

        if (ruleCallers.length === 0 || ruleEndpoints.length === 0) continue;

        let applied = false;
        for (const caller of ruleCallers) {
          let transformedUrl = caller.urlLiteral!;

          // Apply transform.
          if (rule.transform.stripPrefix && transformedUrl.startsWith(rule.transform.stripPrefix)) {
            transformedUrl = transformedUrl.slice(rule.transform.stripPrefix.length);
          } else if (rule.transform.addPrefix) {
            transformedUrl = rule.transform.addPrefix + transformedUrl;
          } else if (rule.transform.replacePrefix) {
            const { from: fp, to: tp } = rule.transform.replacePrefix;
            if (transformedUrl.startsWith(fp)) {
              transformedUrl = tp + transformedUrl.slice(fp.length);
            }
          }

          // Adjust segment count when a prefix is stripped. The stripped
          // prefix contributes segments that are no longer in the URL.
          let adjustedSegmentCount = caller.templateSegmentCount ?? null;
          if (adjustedSegmentCount !== null && rule.transform.stripPrefix) {
            const strippedSegments = rule.transform.stripPrefix.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean).length;
            adjustedSegmentCount = Math.max(1, adjustedSegmentCount - strippedSegments);
          }

          // Transform templateParts to match the transformed URL.
          // TODO: also handle addPrefix and replacePrefix transforms on templateParts.
          let adjustedParts = caller.templateParts ?? null;
          if (adjustedParts && rule.transform.stripPrefix) {
            const stripped = [...adjustedParts];
            if (stripped[0] && stripped[0].startsWith(rule.transform.stripPrefix)) {
              stripped[0] = stripped[0].slice(rule.transform.stripPrefix.length);
            }
            adjustedParts = stripped;
          }

          // Try matching the transformed URL.
          const results = matchCallerToEndpoints(
            {
              id: caller.id,
              httpMethod: caller.httpMethod,
              urlLiteral: transformedUrl,
              egressConfidence: caller.egressConfidence,
              templateSpanCount: caller.templateSpanCount ?? null,
              templateSegmentCount: adjustedSegmentCount,
              templateParts: adjustedParts,
            },
            ruleEndpoints.map((e) => ({ id: e.id, httpMethod: e.httpMethod, routePattern: e.routePattern }))
          );

          if (results.length > 0) {
            const topRank = results[0].matchRank;
            const topMatches = results.filter((r) => r.matchRank === topRank);
            if (topMatches.length === 1 && topMatches[0].matchConfidence === 'high') {
              const match = topMatches[0];
              const ep = ruleEndpoints.find((e) => e.id === match.endpointId)!;
              store.commit({
                nodes: [],
                edges: [{
                  edgeType: 'RESOLVES_TO_ENDPOINT' as const,
                  from: caller.id,
                  to: match.endpointId,
                  matchedBy: match.matchedBy,
                  matchConfidence: match.matchConfidence,
                  confirmedBy: 'auto' as const,
                  confirmedAt: new Date().toISOString(),
                  strategy: `rule: ${rule.name}`,
                  fromRepository: caller.repository,
                  toRepository: ep.repository,
                }],
              }, makeBatchMeta('stitch-rule'));
              existingStitchIds.add(caller.id);
              newStitchCount++;
              applied = true;
            }
          }
        }
        if (applied) rulesApplied.push(rule.name);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ newStitches: newStitchCount, rulesApplied }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'ai_stitch_review',
    'Analyze unresolved callers and propose stitching rules or individual matches. Detects common patterns like prefix mismatches across multiple callers and suggests reusable rules.',
    {
      maxCallers: z.number().optional().describe('Max unresolved callers to analyze (default: 30)'),
    },
    async ({ maxCallers }) => {
      const callers = store.findNodes('ClientSideAPICaller');
      const endpoints = store.findNodes('APIEndpoint');
      const stitchedIds = new Set(
        store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT').map((e) => e.from)
      );

      // Find unresolved non-dynamic callers.
      const unresolvedCallers = callers.filter((c) =>
        !stitchedIds.has(c.id) && c.urlLiteral && c.egressConfidence !== 'dynamic'
      ).slice(0, maxCallers ?? 30);

      if (unresolvedCallers.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ message: 'No unresolved callers to review', proposals: [] }) }],
        };
      }

      // Analyze prefix patterns: group callers by repo and detect common prefixes.
      const repoCallers = new Map<string, Array<{ url: string; id: string }>>();
      for (const c of unresolvedCallers) {
        const list = repoCallers.get(c.repository) ?? [];
        list.push({ url: c.urlLiteral!, id: c.id });
        repoCallers.set(c.repository, list);
      }

      const proposals: Array<{
        type: 'rule' | 'stitch';
        reasoning: string;
        rule?: { name: string; from: string; to: string; transform: Record<string, unknown> };
        stitch?: { callerId: string; endpointId: string };
        affectedCallers?: number;
      }> = [];

      // For each repo's unresolved callers, detect prefix mismatches with endpoints.
      for (const [repo, callerList] of repoCallers) {
        // Find candidate target repos (repos that have endpoints).
        const targetRepos = [...new Set(endpoints.map((e) => e.repository))];

        for (const targetRepo of targetRepos) {
          if (targetRepo === repo) continue; // Skip same-repo (already matched)

          const targetEndpoints = endpoints.filter((e) => e.repository === targetRepo);
          if (targetEndpoints.length === 0) continue;

          // Detect common prefix: for each caller, find the longest prefix
          // that, when stripped, would make the URL match an endpoint.
          const prefixCounts = new Map<string, number>();

          for (const caller of callerList) {
            for (const ep of targetEndpoints) {
              const callerPath = caller.url.replace(/\/$/, '');
              const epPath = ep.routePattern.replace(/\/$/, '');

              if (callerPath.endsWith(epPath) && callerPath.length > epPath.length) {
                const prefix = callerPath.slice(0, callerPath.length - epPath.length);
                prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
              }
            }
          }

          // If a prefix appears for multiple callers, propose a rule.
          for (const [prefix, count] of prefixCounts) {
            if (count >= 2) { // At least 2 callers share this prefix
              proposals.push({
                type: 'rule',
                reasoning: `${count} callers from "${repo}" have prefix "${prefix}" that doesn't exist on "${targetRepo}" endpoints. Stripping it would enable matching.`,
                rule: {
                  name: `Strip "${prefix}" from ${repo} → ${targetRepo}`,
                  from: repo,
                  to: targetRepo,
                  transform: { stripPrefix: prefix },
                },
                affectedCallers: count,
              });
            }
          }
        }

        // Also detect callers that are external API calls (https://).
        const externalCallers = callerList.filter((c) => c.url.startsWith('http'));
        if (externalCallers.length > 0) {
          proposals.push({
            type: 'rule',
            reasoning: `${externalCallers.length} callers from "${repo}" call external URLs (https://...). These are third-party API calls and should not be stitched to local endpoints.`,
            affectedCallers: externalCallers.length,
          });
        }
      }

      // Deduplicate and sort by affected callers.
      const seen = new Set<string>();
      const deduped = proposals.filter((p) => {
        const key = p.rule ? `${p.rule.from}-${p.rule.to}-${JSON.stringify(p.rule.transform)}` : p.reasoning;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => (b.affectedCallers ?? 0) - (a.affectedCallers ?? 0));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            totalUnresolved: unresolvedCallers.length,
            proposals: deduped,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'suggest_stitches',
    'Propose matches between client-side API calls and server-side endpoints. Returns tiered results: deterministic (exact URL, segment-count), heuristic (pattern prefix), and ambiguous (multiple candidates).',
    {},
    async () => {
      const callers = store.findNodes('ClientSideAPICaller');
      const endpoints = store.findNodes('APIEndpoint');

      // #269 — apply application-scope here too so suggest_stitches'
      // ambiguity tier matches what the real stitcher (stitch /
      // auto_stitch) considers candidates. Without this, projects with
      // an `applications` declaration see suggest_stitches flag dozens
      // of cross-app duplicate routes as "ambiguous" even though the
      // real stitcher correctly resolved them via the scope.
      const applicationScope = loadApplicationScope();
      const endpointRepoById = new Map<string, string>(endpoints.map((e) => [e.id, e.repository]));

      const matcherEndpoints = endpoints.map((e) => ({
        id: e.id,
        httpMethod: e.httpMethod,
        routePattern: e.routePattern,
      }));

      const suggestions: Array<{
        callerId: string;
        callerDescription: string;
        matches: Array<{
          endpointId: string;
          endpointDescription: string;
          confidence: string;
          matchedBy: string;
          matchRank: number;
        }>;
        tier: 'deterministic' | 'heuristic' | 'ambiguous' | 'unmatched';
        existingStitch: boolean;
      }> = [];

      for (const caller of callers) {
        if (caller.urlLiteral === null || caller.egressConfidence === 'dynamic') continue;

        // Check if already stitched
        const existingEdges = store.findEdges(caller.id, null, 'RESOLVES_TO_ENDPOINT');
        const existingStitch = existingEdges.length > 0;

        const scopedEndpoints = applicationScope
          ? matcherEndpoints.filter((me) => {
              const repo = endpointRepoById.get(me.id);
              return repo === undefined || applicationScope(caller.repository, repo);
            })
          : matcherEndpoints;

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
          scopedEndpoints
        );

        const callerDesc = `${caller.httpMethod ?? '?'} ${caller.urlLiteral} (${caller.egressConfidence})`;

        if (results.length === 0) {
          suggestions.push({
            callerId: caller.id,
            callerDescription: callerDesc,
            matches: [],
            tier: 'unmatched',
            existingStitch,
          });
          continue;
        }

        const topRank = results[0].matchRank;
        const topMatches = results.filter((r) => r.matchRank === topRank);

        let tier: 'deterministic' | 'heuristic' | 'ambiguous';
        if (topMatches.length > 1) {
          tier = 'ambiguous';
        } else if (topMatches[0].matchConfidence === 'high') {
          tier = 'deterministic';
        } else {
          tier = 'heuristic';
        }

        const matchDetails = results.map((r) => {
          const ep = endpoints.find((e) => e.id === r.endpointId)!;
          return {
            endpointId: r.endpointId,
            endpointDescription: `${ep.httpMethod} ${ep.routePattern}`,
            confidence: r.matchConfidence,
            matchedBy: r.matchedBy,
            matchRank: r.matchRank,
          };
        });

        suggestions.push({
          callerId: caller.id,
          callerDescription: callerDesc,
          matches: matchDetails,
          tier,
          existingStitch,
        });
      }

      // Group by tier for readability
      const grouped = {
        deterministic: suggestions.filter((s) => s.tier === 'deterministic'),
        heuristic: suggestions.filter((s) => s.tier === 'heuristic'),
        ambiguous: suggestions.filter((s) => s.tier === 'ambiguous'),
        unmatched: suggestions.filter((s) => s.tier === 'unmatched'),
        summary: {
          total: suggestions.length,
          deterministic: suggestions.filter((s) => s.tier === 'deterministic').length,
          heuristic: suggestions.filter((s) => s.tier === 'heuristic').length,
          ambiguous: suggestions.filter((s) => s.tier === 'ambiguous').length,
          unmatched: suggestions.filter((s) => s.tier === 'unmatched').length,
          alreadyStitched: suggestions.filter((s) => s.existingStitch).length,
        },
      };

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(grouped, null, 2) },
        ],
      };
    }
  );

  server.tool(
    'confirm_stitch',
    'Confirm a match between a client-side API caller and a server-side endpoint. Stores a RESOLVES_TO_ENDPOINT edge with audit metadata.',
    {
      callerId: z.string().describe('The ClientSideAPICaller node id'),
      endpointId: z.string().describe('The APIEndpoint node id'),
      reason: z.string().optional().describe('Why this match is correct'),
    },
    async ({ callerId, endpointId, reason }) => {
      const caller = store.getNode('ClientSideAPICaller', callerId);
      if (!caller) {
        return { content: [{ type: 'text' as const, text: 'Caller not found' }], isError: true };
      }
      const endpoint = store.getNode('APIEndpoint', endpointId);
      if (!endpoint) {
        return { content: [{ type: 'text' as const, text: 'Endpoint not found' }], isError: true };
      }

      // Check for existing stitch to avoid duplicates.
      const existing = store.findEdges(callerId, endpointId, 'RESOLVES_TO_ENDPOINT');
      if (existing.length > 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                message: `Already stitched: ${caller.httpMethod ?? '?'} ${caller.urlLiteral} → ${endpoint.httpMethod} ${endpoint.routePattern}`,
                existingEdge: existing[0],
              }, null, 2),
            },
          ],
        };
      }

      // Derive matchedBy from the actual URL comparison.
      const matchedBy: 'exact-url' | 'pattern' | 'inferred' =
        caller.egressConfidence === 'exact' && caller.urlLiteral === endpoint.routePattern
          ? 'exact-url'
          : 'pattern';

      const edge = {
        edgeType: 'RESOLVES_TO_ENDPOINT' as const,
        from: callerId,
        to: endpointId,
        matchedBy,
        matchConfidence: 'high' as const,
        confirmedBy: 'human' as const,
        confirmedAt: new Date().toISOString(),
        strategy: 'manual-confirmation',
        reason: reason ?? undefined,
        fromRepository: caller.repository,
        toRepository: endpoint.repository,
      };

      store.commit(
        { nodes: [], edges: [edge] },
        makeBatchMeta('stitch-confirm')
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              message: `Confirmed: ${caller.httpMethod ?? '?'} ${caller.urlLiteral} → ${endpoint.httpMethod} ${endpoint.routePattern}`,
              edge,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'reject_stitch',
    'Record rejection of a proposed match between a client-side API caller and a server-side endpoint. Note: edge deletion is not yet supported — the rejection is recorded but the edge remains if one exists.',
    {
      callerId: z.string().describe('The ClientSideAPICaller node id'),
      endpointId: z.string().describe('The APIEndpoint node id'),
      reason: z.string().optional().describe('Why this match is wrong'),
    },
    async ({ callerId, endpointId, reason }) => {
      // Check if edge exists
      const edges = store.findEdges(callerId, endpointId, 'RESOLVES_TO_ENDPOINT');
      if (edges.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No existing stitch edge to reject' }],
        };
      }

      // Note: The current graph store doesn't support edge deletion.
      // For now, we record the rejection as metadata. A future version
      // could add a deleteEdge method or mark edges as rejected.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              message: `Rejection recorded for ${callerId} → ${endpointId}`,
              reason: reason ?? 'No reason provided',
              note: 'Edge deletion not yet supported — edge remains but rejection is recorded',
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'auto_stitch',
    'Automatically accept all stitch suggestions at or above the specified confidence level. Use dryRun to preview without committing.',
    {
      minConfidence: z
        .enum(['deterministic', 'heuristic', 'all'])
        .optional()
        .describe('Minimum confidence tier to accept (default: deterministic)'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Preview matches without committing (default: false)'),
    },
    async ({ minConfidence, dryRun }) => {
      const tier = minConfidence ?? 'deterministic';
      const preview = dryRun ?? false;

      const callers = store.findNodes('ClientSideAPICaller');
      const endpoints = store.findNodes('APIEndpoint');

      // #255 — apply application-scope here too so auto_stitch never
      // commits cross-app RESOLVES_TO_ENDPOINT edges that the CLI's
      // application-pair scoping suppressed.
      const applicationScope = loadApplicationScope();
      const endpointRepoById = new Map<string, string>(endpoints.map((e) => [e.id, e.repository]));

      const matcherEndpoints = endpoints.map((e) => ({
        id: e.id,
        httpMethod: e.httpMethod,
        routePattern: e.routePattern,
      }));

      const edgesToCommit: Array<{
        edgeType: 'RESOLVES_TO_ENDPOINT';
        from: string;
        to: string;
        matchedBy: 'exact-url' | 'pattern' | 'inferred';
        matchConfidence: 'high' | 'medium' | 'low';
        confirmedBy: 'auto';
        confirmedAt: string;
        strategy: string;
        fromRepository: string;
        toRepository: string;
      }> = [];

      for (const caller of callers) {
        if (caller.urlLiteral === null || caller.egressConfidence === 'dynamic') continue;

        // Skip already stitched
        const existing = store.findEdges(caller.id, null, 'RESOLVES_TO_ENDPOINT');
        if (existing.length > 0) continue;

        const scopedEndpoints = applicationScope
          ? matcherEndpoints.filter((me) => {
              const repo = endpointRepoById.get(me.id);
              return repo === undefined || applicationScope(caller.repository, repo);
            })
          : matcherEndpoints;

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
          scopedEndpoints
        );

        if (results.length === 0) continue;

        const topRank = results[0].matchRank;
        const topMatches = results.filter((r) => r.matchRank === topRank);

        // Skip ambiguous matches
        if (topMatches.length > 1) continue;

        const match = topMatches[0];

        // Apply confidence filter
        if (tier === 'deterministic' && match.matchConfidence !== 'high') continue;
        if (tier === 'heuristic' && match.matchConfidence === 'low') continue;

        const ep = endpoints.find((e) => e.id === match.endpointId)!;
        edgesToCommit.push({
          edgeType: 'RESOLVES_TO_ENDPOINT',
          from: caller.id,
          to: match.endpointId,
          matchedBy: match.matchedBy,
          matchConfidence: match.matchConfidence,
          confirmedBy: 'auto',
          confirmedAt: new Date().toISOString(),
          strategy: `auto-stitch-${tier}`,
          fromRepository: caller.repository,
          toRepository: ep.repository,
        });
      }

      if (!preview && edgesToCommit.length > 0) {
        store.commit(
          { nodes: [], edges: edgesToCommit },
          makeBatchMeta('auto-stitch')
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              mode: preview ? 'dry-run' : 'committed',
              minConfidence: tier,
              edgesCount: edgesToCommit.length,
              edges: edgesToCommit.map((e) => {
                const caller = callers.find((c) => c.id === e.from)!;
                const ep = endpoints.find((ep) => ep.id === e.to)!;
                return {
                  caller: `${caller.httpMethod ?? '?'} ${caller.urlLiteral}`,
                  endpoint: `${ep.httpMethod} ${ep.routePattern}`,
                  confidence: e.matchConfidence,
                  matchedBy: e.matchedBy,
                };
              }),
            }, null, 2),
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // Analysis tools
  // ──────────────────────────────────────────────────────────────────

  server.tool(
    'list_server_endpoints',
    'List all API endpoints from the server-side code with their downstream effects — handler function, database tables read and written, and completeness status.',
    {
      repository: z.string().optional().describe('Only endpoints from this repository'),
    },
    async ({ repository }) => {
      const endpoints = store.findNodes('APIEndpoint', repository ? { repository } as any : undefined);

      const result = endpoints.map((ep) => {
        // Resolve handler
        const handler = ep.handlerFunctionId
          ? store.getNode('FunctionDefinition', ep.handlerFunctionId)
          : null;

        // Walk from endpoint to find database interactions
        const readsFrom: string[] = [];
        const writesTo: string[] = [];

        if (handler) {
          // BFS from handler to find all reachable functions
          const visited = new Set<string>();
          const frontier = [handler.id];
          while (frontier.length > 0) {
            const fnId = frontier.pop()!;
            if (visited.has(fnId)) continue;
            visited.add(fnId);

            // Check for database interactions via PERFORMED_BY edges
            const performedByEdges = store.findEdges(null, fnId, 'PERFORMED_BY');
            for (const pbe of performedByEdges) {
              const interaction = store.getNodeById(pbe.from);
              if (interaction && interaction.nodeType === 'DatabaseInteraction') {
                const readsEdges = store.findEdges(interaction.id, null, 'READS');
                for (const re of readsEdges) {
                  const table = store.getNode('DatabaseTable', re.to);
                  if (table && !readsFrom.includes(table.name)) readsFrom.push(table.name);
                }
                const writesEdges = store.findEdges(interaction.id, null, 'WRITES');
                for (const we of writesEdges) {
                  const table = store.getNode('DatabaseTable', we.to);
                  if (table && !writesTo.includes(table.name)) writesTo.push(table.name);
                }
              }
            }

            // Follow call graph
            const callEdges = store.findEdges(fnId, null, 'CALLS_FUNCTION');
            for (const ce of callEdges) {
              if (!visited.has(ce.to)) frontier.push(ce.to);
            }
          }
        }

        return {
          id: ep.id,
          httpMethod: ep.httpMethod,
          routePattern: ep.routePattern,
          handler: handler?.name ?? null,
          handlerResolved: handler !== null,
          readsFrom,
          writesTo,
          requestFields: handler?.requestFields ?? [],
          framework: ep.framework,
          middleware: ep.middlewareChain?.map((m) => m.name) ?? [],
          sourceFile: ep.evidence?.filePath ?? null,
          sourceLine: ep.evidence?.lineStart ?? null,
        };
      });

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  server.tool(
    'list_client_api_calls',
    'List all outbound API calls from the client-side code with their trigger context — which component, which UI event or lifecycle hook, and the HTTP method + URL.',
    {
      repository: z.string().optional().describe('Only callers from this repository'),
    },
    async ({ repository }) => {
      const callers = store.findNodes('ClientSideAPICaller', repository ? { repository } as any : undefined);
      const result = callers.map((caller) => {
        // Find the MAKES_REQUEST edge to get the function that makes this call
        const makesRequestEdges = store.findEdges(null, caller.id, 'MAKES_REQUEST');
        const callerFn = makesRequestEdges.length > 0
          ? store.getNode('FunctionDefinition', makesRequestEdges[0].from)
          : null;

        // Find the TRIGGERS edge that points to this function's enclosing context
        // Walk up: process → TRIGGERS → callback → (callback is callerFn or parent of callerFn)
        const processes = store.findNodes('ClientSideProcess');
        let triggerProcess: { kind: string; name: string } | null = null;
        for (const proc of processes) {
          const triggersEdges = store.findEdges(proc.id, null, 'TRIGGERS');
          for (const te of triggersEdges) {
            if (te.to === caller.functionId || (callerFn && te.to === callerFn.id)) {
              triggerProcess = { kind: proc.kind, name: proc.name };
              break;
            }
          }
          if (triggerProcess) break;
        }

        // Resolve the component name from the source file
        const sourceFile = store.getNode('SourceFile', caller.sourceFileId);

        return {
          id: caller.id,
          component: callerFn?.name?.split('.')[0] ?? null,
          trigger: triggerProcess?.name ?? null,
          triggerKind: triggerProcess?.kind ?? null,
          httpMethod: caller.httpMethod,
          url: caller.urlLiteral,
          urlConfidence: caller.egressConfidence,
          sourceFile: sourceFile?.filePath ?? null,
          sourceLine: caller.sourceLine,
        };
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  server.tool(
    'list_unmatched_callers',
    'List ClientSideAPICallers that have no RESOLVES_TO_ENDPOINT edge — either dynamic URLs or no matching endpoint. External API calls are excluded by default.',
    {
      includeExternal: z.boolean().optional().describe('Include external API calls (default: false)'),
    },
    async ({ includeExternal }) => {
      const callers = store.findNodes('ClientSideAPICaller');
      const unmatched = callers.filter((c) => {
        if (!includeExternal && c.isExternal) return false;
        const edges = store.findEdges(c.id, null, 'RESOLVES_TO_ENDPOINT');
        return edges.length === 0;
      });
      // #271 — curated shape, mirrors list_uncalled_endpoints. Drops
      // nodeType / functionId / sourceFileId etc. that aren't useful
      // here.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              total: unmatched.length,
              totalCallers: callers.length,
              callers: unmatched.map((c) => ({
                id: c.id,
                httpMethod: c.httpMethod,
                urlLiteral: c.urlLiteral,
                egressConfidence: c.egressConfidence,
                framework: c.framework,
                repository: c.repository,
                isExternal: c.isExternal ?? false,
                // Jump-to-source affordances — most common next agent
                // step after seeing an unmatched caller is to inspect
                // the caller's code.
                sourceFileId: c.sourceFileId,
                sourceLine: c.sourceLine,
              })),
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'list_incomplete_flows',
    'List flows that stopped before reaching the database — useful for identifying gaps in the graph.',
    {
      maxCallDepth: z
        .number()
        .optional()
        .describe('Max call-graph traversal depth (default: 10)'),
      maxHops: z.number().optional().describe('Max service-to-service hops (default: 1, max: 5)'),
    },
    async ({ maxCallDepth, maxHops }) => {
      const walker = createFlowWalker(store, {
        maxCallDepth: maxCallDepth ?? 10,
        maxHops: maxHops ?? 1,
      });
      const flows = walker.walkAllProcesses();
      const incomplete = flows.filter((f) => f.completeness !== 'complete');
      // #276 — strip always-null/empty fields per entry. Incomplete
      // flows by definition didn't reach an endpoint, so endpoint /
      // matchConfidence / matchedBy / handlerFunction are deterministic
      // null and databaseHops / serviceHops / responses /
      // responseHandlers are deterministic empty arrays. Shipping them
      // wastes ~50% of payload bytes on zero-information output.
      const formatted = formatFlows(incomplete, false).map((f) => stripNullishFields(f));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatted, null, 2),
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // Advanced analysis tools (#118)
  // ──────────────────────────────────────────────────────────────────

  server.tool(
    'impact_analysis',
    'Analyze the blast radius of a change: given an endpoint route, table name, or file path, return all upstream callers and downstream dependencies.',
    {
      routePattern: z.string().optional().describe('Route pattern to analyze (e.g., "/api/users/:id")'),
      tableName: z.string().optional().describe('Database table name to analyze'),
      filePath: z.string().optional().describe('Source file path to analyze'),
    },
    async ({ routePattern, tableName, filePath }) => {
      const walker = createFlowWalker(store, { maxCallDepth: 10 });
      const allFlows = walker.walkAllProcesses();
      const completeFlows = allFlows.filter((f) => f.completeness === 'complete');

      if (routePattern) {
        // Find the endpoint and all flows through it.
        const endpoint = store.findNodes('APIEndpoint').find((e) => e.routePattern === routePattern);
        if (!endpoint) {
          return errorResponse(
            `Endpoint with routePattern "${routePattern}" not found`,
            'NOT_FOUND',
            'Use list_server_endpoints to find valid route patterns.',
          );
        }
        const affectedFlows = completeFlows.filter((f) => f.endpoint?.routePattern === routePattern);
        const callers = affectedFlows.map((f) => ({
          process: f.startProcess.name,
          kind: f.startProcess.kind,
          caller: f.caller ? `${f.caller.httpMethod} ${f.caller.urlLiteral}` : null,
        }));
        const tables = [...new Set(affectedFlows.flatMap((f) =>
          f.databaseHops.flatMap((h) => [...h.readsTables.map((t) => t.name), ...h.writesTables.map((t) => t.name)])
        ))];
        // Find other endpoints that share these tables.
        const sharedEndpoints = completeFlows
          .filter((f) => f.endpoint?.routePattern !== routePattern &&
            f.databaseHops.some((h) =>
              h.readsTables.some((t) => tables.includes(t.name)) ||
              h.writesTables.some((t) => tables.includes(t.name))
            ))
          .map((f) => `${f.endpoint?.httpMethod} ${f.endpoint?.routePattern}`)
          .filter((v, i, a) => a.indexOf(v) === i);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              endpoint: `${endpoint.httpMethod} ${endpoint.routePattern}`,
              handler: endpoint.handlerFunctionId ? store.getNode('FunctionDefinition', endpoint.handlerFunctionId)?.name : null,
              calledBy: callers,
              touchesTables: tables,
              otherEndpointsSharingTables: sharedEndpoints,
              affectedFlowCount: affectedFlows.length,
            }, null, 2),
          }],
        };
      }

      if (tableName) {
        // #274 — verify the table exists before computing flows so a
        // typo doesn't return an empty-but-valid response.
        const tableExists = store.findNodes('DatabaseTable').some((t) => t.name === tableName);
        if (!tableExists) {
          return errorResponse(
            `Table "${tableName}" not found`,
            'NOT_FOUND',
            'Use list_nodes type=DatabaseTable to find valid table names.',
          );
        }
        const affectedFlows = completeFlows.filter((f) =>
          f.databaseHops.some((h) =>
            h.readsTables.some((t) => t.name === tableName) ||
            h.writesTables.some((t) => t.name === tableName)
          )
        );
        const endpoints = [...new Set(affectedFlows.map((f) => `${f.endpoint?.httpMethod} ${f.endpoint?.routePattern}`))];
        const operations = affectedFlows.flatMap((f) =>
          f.databaseHops
            .filter((h) => h.readsTables.some((t) => t.name === tableName) || h.writesTables.some((t) => t.name === tableName))
            .map((h) => h.interaction.operation)
        );
        const opCounts: Record<string, number> = {};
        for (const op of operations) opCounts[op] = (opCounts[op] ?? 0) + 1;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              table: tableName,
              affectedFlowCount: affectedFlows.length,
              endpoints,
              operations: opCounts,
            }, null, 2),
          }],
        };
      }

      if (filePath) {
        const affectedFlows = allFlows.filter((f) => {
          const nodes = [f.startProcess, f.caller, f.endpoint, f.handlerFunction].filter(Boolean);
          return nodes.some((n) => {
            if (!n) return false;
            if ('evidence' in n && n.evidence?.filePath === filePath) return true;
            if ('sourceFileId' in n) {
              const sf = store.getNode('SourceFile', (n as { sourceFileId: string }).sourceFileId);
              return sf?.filePath === filePath;
            }
            return false;
          });
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              file: filePath,
              affectedFlowCount: affectedFlows.length,
              flows: affectedFlows.slice(0, 20).map((f) => ({
                process: f.startProcess.name,
                endpoint: f.endpoint ? `${f.endpoint.httpMethod} ${f.endpoint.routePattern}` : null,
                completeness: f.completeness,
              })),
            }, null, 2),
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: 'Provide routePattern, tableName, or filePath' }], isError: true };
    }
  );

  server.tool(
    'diff_flows',
    'Given a list of changed file paths (from a git diff), return all flows that pass through any of the changed files. Useful for PR reviews.',
    {
      changedFiles: z.array(z.string()).describe('List of changed file paths (relative to project root)'),
    },
    async ({ changedFiles }) => {
      const walker = createFlowWalker(store, { maxCallDepth: 10 });
      const allFlows = walker.walkAllProcesses();
      const changedSet = new Set(changedFiles);

      const affectedFlows = allFlows.filter((f) => {
        const nodes = [f.startProcess, f.caller, f.endpoint, f.handlerFunction].filter(Boolean);
        return nodes.some((n) => {
          if (!n) return false;
          if ('evidence' in n && n.evidence && changedSet.has(n.evidence.filePath)) return true;
          if ('sourceFileId' in n) {
            const sf = store.getNode('SourceFile', (n as { sourceFileId: string }).sourceFileId);
            return sf ? changedSet.has(sf.filePath) : false;
          }
          return false;
        });
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            changedFiles,
            affectedFlowCount: affectedFlows.length,
            flows: affectedFlows.map((f) => ({
              process: `${f.startProcess.kind} "${f.startProcess.name}"`,
              endpoint: f.endpoint ? `${f.endpoint.httpMethod} ${f.endpoint.routePattern}` : null,
              handler: f.handlerFunction?.name ?? null,
              tables: f.databaseHops.flatMap((h) => [
                ...h.readsTables.map((t) => `reads ${t.name}`),
                ...h.writesTables.map((t) => `writes ${t.name}`),
              ]),
              completeness: f.completeness,
            })),
          }, null, 2),
        }],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // Source file retrieval tool (#96)
  // ──────────────────────────────────────────────────────────────────

  server.tool(
    'get_source_file',
    'Retrieve source file content for a graph node OR a file path. Pass either `nodeId` (content-addressed) or `filePath` (full or substring; first SourceFile match wins). Returns the relevant source lines with surrounding context.',
    {
      nodeId: z.string().optional().describe('The content-addressed node id to look up source for'),
      filePath: z.string().optional().describe('A file path, full or substring; matches against SourceFile.filePath'),
      contextLines: z
        .number()
        .optional()
        .describe('Extra lines of context around the evidence range (default: 5)'),
    },
    async ({ nodeId, filePath: filePathArg, contextLines }) => {
      if (!projectRoot) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'get_source_file requires --project-root to be set when starting the server',
            },
          ],
          isError: true,
        };
      }

      if (!nodeId && !filePathArg) {
        return errorResponse(
          'Pass either nodeId or filePath',
          'INVALID_INPUT',
          'Either provide a content-addressed node id or a file path / substring to look up.',
        );
      }

      let node = nodeId ? store.getNodeById(nodeId) : null;
      // Fall back to filePath lookup when nodeId is missing OR when
      // the lookup returned null. Exact match wins over substring.
      // #339 — uses the lazy SourceFile index (Map<filePath, SourceFile>)
      // so repeated calls don't re-scan SQLite.
      if (!node && filePathArg) {
        const index = getSourceFileIndex(store);
        const exact = index.byExactPath.get(filePathArg);
        let partial: typeof exact = undefined;
        if (!exact) {
          for (const sf of index.byExactPath.values()) {
            if (sf.filePath.includes(filePathArg)) {
              partial = sf;
              break;
            }
          }
        }
        node = exact ?? partial ?? null;
      }
      if (!node) {
        return errorResponse(
          `Node not found${nodeId ? ` for nodeId=${nodeId}` : ''}${filePathArg ? ` matching filePath=${filePathArg}` : ''}`,
          'NOT_FOUND',
          'Use list_nodes or list_repositories to find valid ids / file paths.',
        );
      }

      // Resolve the file path from evidence or sourceFileId fallback.
      let filePath: string | null = null;
      let lineStart: number | null = null;
      let lineEnd: number | null = null;

      if ('evidence' in node && node.evidence) {
        const ev = node.evidence;
        filePath = ev.filePath;
        lineStart = ev.lineStart;
        lineEnd = ev.lineEnd;
      } else if ('sourceFileId' in node) {
        const sfNode = store.getNode('SourceFile', node.sourceFileId);
        if (sfNode) filePath = sfNode.filePath;
      } else if (node.nodeType === 'SourceFile') {
        filePath = node.filePath;
      }

      if (!filePath) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Could not determine source file path for this node',
            },
          ],
          isError: true,
        };
      }

      // Resolve the file path. For multi-repo projects, the graph stores
      // relative paths like "src/routes/projects.ts" but the actual file
      // may be at "apps/api/src/routes/projects.ts". Try the direct path
      // first, then search common monorepo subdirectories.
      const safePRoot = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;

      let absolutePath = path.resolve(projectRoot, filePath);
      let fileContent: string | null = null;

      // Guard against path traversal.
      if (!absolutePath.startsWith(safePRoot) && absolutePath !== projectRoot) {
        return {
          content: [{ type: 'text' as const, text: 'Path traversal denied' }],
          isError: true,
        };
      }

      // Try direct path first.
      try {
        fileContent = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        // Multi-repo fallback: graph stores relative paths per repo
        // (e.g., "src/routes/projects.ts") but the project root may be
        // the monorepo root, not the repo root. Search common subdirs.
        //
        // SECURITY: Every candidate path is checked against safePRoot
        // to prevent path traversal. The repo name comes from the graph
        // DB (user-controlled at analysis time, not at query time), and
        // path.join normalizes away any ".." segments. The startsWith
        // check is the definitive security boundary.
        const repo = 'repository' in node ? (node as { repository: string }).repository : null;
        const searchDirs: string[] = [];

        // Try repo-named subdirectories
        if (repo) {
          searchDirs.push(
            path.join(projectRoot, repo, filePath),
            path.join(projectRoot, 'apps', repo, filePath),
            path.join(projectRoot, 'packages', repo, filePath),
            path.join(projectRoot, 'services', repo, filePath),
          );
        }

        // Try all subdirectories under common monorepo parents
        for (const parent of ['apps', 'packages', 'services']) {
          try {
            const entries = await fs.readdir(path.join(projectRoot, parent), { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                searchDirs.push(path.join(projectRoot, parent, entry.name, filePath));
              }
            }
          } catch { /* parent dir doesn't exist */ }
        }

        for (const candidate of searchDirs) {
          // Path traversal check for each candidate.
          if (!candidate.startsWith(safePRoot)) continue;
          try {
            fileContent = await fs.readFile(candidate, 'utf-8');
            absolutePath = candidate;
            break;
          } catch { /* try next */ }
        }
      }

      if (fileContent === null) {
        return {
          content: [{
            type: 'text' as const,
            text: `File not found: ${filePath} (searched project root and subdirectories)`,
          }],
          isError: true,
        };
      }

      const lines = fileContent.split('\n');
      const ctx = Math.min(Math.max(0, contextLines ?? 5), 200);

      if (lineStart !== null && lineEnd !== null) {
        // Return the evidence range with surrounding context.
        const start = Math.max(0, lineStart - 1 - ctx);
        const end = Math.min(lines.length, lineEnd + ctx);
        const numbered = lines
          .slice(start, end)
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  filePath,
                  totalLines: lines.length,
                  evidenceRange: { lineStart, lineEnd },
                  displayRange: { lineStart: start + 1, lineEnd: end },
                  content: numbered,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // No line range — return the full file.
      const numbered = lines.map((line, i) => `${i + 1}\t${line}`).join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { filePath, totalLines: lines.length, content: numbered },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // Developer debugging tools (#139)
  // ──────────────────────────────────────────────────────────────────

  server.tool(
    'list_uncalled_endpoints',
    'Find API endpoints that have no incoming RESOLVES_TO_ENDPOINT edges — no known frontend caller reaches them. Useful for finding dead/unused endpoints.',
    {
      repository: z.string().optional().describe('Scope to a single repository'),
    },
    async ({ repository }) => {
      const repoFilter = repository ? { repository } as any : undefined;
      const endpoints = store.findNodes('APIEndpoint', repoFilter);
      const allStitchEdges = store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT');
      const calledEndpointIds = new Set(allStitchEdges.map((e) => e.to));

      const uncalled = endpoints.filter((ep) => !calledEndpointIds.has(ep.id));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: uncalled.length,
            totalEndpoints: endpoints.length,
            endpoints: uncalled.map((ep) => ({
              id: ep.id,
              httpMethod: ep.httpMethod,
              routePattern: ep.routePattern,
              framework: ep.framework,
              repository: ep.repository,
            })),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'list_unreachable_screens',
    'Find Screen nodes that have no incoming NAVIGATES_TO edges — no navigation call reaches them. Useful for finding dead/orphaned screens in React Native apps.',
    {
      repository: z.string().optional().describe('Scope to a single repository'),
    },
    async ({ repository }) => {
      const repoFilter = repository ? { repository } as any : undefined;
      const screenNodes = store.findNodes('Screen', repoFilter);
      const allNavEdges = store.findEdges(null, null, 'NAVIGATES_TO');
      const navigatedScreenIds = new Set(allNavEdges.map((e) => e.to));

      const unreachable = screenNodes.filter((s) => !navigatedScreenIds.has(s.id));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: unreachable.length,
            totalScreens: screenNodes.length,
            screens: unreachable.map((s) => ({
              id: s.id,
              name: s.name,
              navigatorKind: s.navigatorKind,
              componentFunctionId: s.componentFunctionId,
            })),
          }, null, 2),
        }],
      };
    }
  );

  // #11 — list_orphan_tables: parallel to list_unreachable_screens.
  // A DatabaseTable is "orphan" when no DatabaseInteraction has a
  // READS or WRITES edge pointing at it. Useful for spotting tables
  // declared in the schema (Prisma model, Mongoose Schema, etc.) but
  // never actually read or written — either intentional (future work)
  // or a wiring oversight.
  //
  // Repository scoping is intentionally omitted in this MVP. A future
  // enhancement could join DatabaseTable → TABLE_IN → DatabaseSystem
  // (which is keyed by repository in idFor.databaseSystem) to filter
  // by repo.
  server.tool(
    'list_orphan_tables',
    'Find DatabaseTable nodes that no DatabaseInteraction reads or writes. Useful for spotting tables declared in the schema but never queried — either intentional (future feature) or a wiring oversight.',
    {},
    async () => {
      const tableNodes = store.findNodes('DatabaseTable');
      const allReads = store.findEdges(null, null, 'READS');
      const allWrites = store.findEdges(null, null, 'WRITES');
      const touchedTableIds = new Set<string>([
        ...allReads.map((e) => e.to),
        ...allWrites.map((e) => e.to),
      ]);
      const orphans = tableNodes.filter((t) => !touchedTableIds.has(t.id));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: orphans.length,
            totalTables: tableNodes.length,
            tables: orphans.map((t) => ({
              id: t.id,
              name: t.name,
              schema: t.schema,
              kind: t.kind,
              systemId: t.systemId,
            })),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'describe_file',
    'Return everything about a source file in one call: functions defined in it, endpoints, API callers, processes, imports, and exports. Accepts a file path substring.',
    {
      filePath: z.string().describe('Full or partial file path (e.g., "src/auth.ts")'),
      repository: z.string().optional().describe('Scope to a single repository'),
      includeEvidence: z.boolean().optional().describe('Include source code evidence (default: false)'),
    },
    async ({ filePath, repository, includeEvidence }) => {
      // Find matching source files
      const repoFilter = repository ? { repository } as any : undefined;
      const allFiles = store.findNodes('SourceFile', repoFilter);
      const matchingFiles = allFiles.filter((f) => f.filePath.includes(filePath));

      if (matchingFiles.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: `No source file matching "${filePath}"`,
            code: 'NOT_FOUND',
            hint: 'Use list_nodes type=SourceFile to find valid file paths.',
            availableFiles: allFiles.map((f) => f.filePath).slice(0, 20),
          }, null, 2) }],
        };
      }

      const results = matchingFiles.map((sf) => {
        const functions = store.findNodes('FunctionDefinition', { sourceFileId: sf.id } as any);
        const endpoints = store.findNodes('APIEndpoint').filter((ep) => {
          if (!ep.handlerFunctionId) return false;
          return functions.some((f) => f.id === ep.handlerFunctionId);
        });
        const callers = store.findNodes('ClientSideAPICaller', { sourceFileId: sf.id } as any);
        const processes = store.findNodes('ClientSideProcess', { sourceFileId: sf.id } as any);
        const screens = store.findNodes('Screen', { sourceFileId: sf.id } as any);
        const importEdges = store.findEdges(sf.id, null, 'IMPORTS');
        const exportEdges = store.findEdges(sf.id, null, 'EXPORTS');

        return {
          sourceFile: { id: sf.id, filePath: sf.filePath, language: sf.language, framework: sf.framework, repository: sf.repository },
          functions: functions.map((f) => ({
            id: f.id, name: f.name, sourceLine: f.sourceLine, isExported: f.isExported, isAsync: f.isAsync,
            ...(includeEvidence ? { evidence: f.evidence ?? null } : {}),
          })),
          endpoints: endpoints.map((ep) => ({
            id: ep.id, httpMethod: ep.httpMethod, routePattern: ep.routePattern, framework: ep.framework,
          })),
          apiCallers: callers.map((c) => ({
            id: c.id, httpMethod: c.httpMethod, urlLiteral: c.urlLiteral, egressConfidence: c.egressConfidence,
          })),
          processes: processes.map((p) => ({
            id: p.id, kind: p.kind, name: p.name, sourceLine: p.sourceLine,
          })),
          screens: screens.map((s) => ({
            id: s.id, name: s.name, navigatorKind: s.navigatorKind,
          })),
          imports: importEdges.length,
          exports: exportEdges.length,
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(results.length === 1 ? results[0] : { matchingFiles: results.length, files: results }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'describe_screen',
    'Return everything about a React Native screen: component function, API calls it makes, screens it navigates to, lifecycle hooks, and event handlers. Accepts a screen name.',
    {
      screenName: z.string().describe('Screen name as declared in the navigator (e.g., "Login", "Home")'),
      repository: z.string().optional().describe('Scope to a single repository'),
      includeEvidence: z.boolean().optional().describe('Include source code evidence (default: false)'),
    },
    async ({ screenName, repository, includeEvidence }) => {
      const repoFilter = repository ? { repository } as any : undefined;
      const screenNodes = store.findNodes('Screen', repoFilter)
        .filter((s) => s.name === screenName);

      if (screenNodes.length === 0) {
        const allScreens = store.findNodes('Screen', repoFilter);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: `No screen named "${screenName}"`,
            code: 'NOT_FOUND',
            hint: 'Use list_nodes type=Screen or list_screens to find valid screen names.',
            availableScreens: allScreens.map((s) => s.name),
          }, null, 2) }],
        };
      }

      const results = screenNodes.map((screen) => {
        // Find the component function
        let componentFunction = screen.componentFunctionId
          ? store.getNode('FunctionDefinition', screen.componentFunctionId)
          : null;
        if (!componentFunction) {
          const compEdges = store.findEdges(screen.id, null, 'SCREEN_COMPONENT');
          if (compEdges.length > 0) {
            componentFunction = store.getNode('FunctionDefinition', compEdges[0].to);
          }
        }

        // Find all processes in the component's source file
        const componentFileId = componentFunction?.sourceFileId ?? null;
        const processes = componentFileId
          ? store.findNodes('ClientSideProcess', { sourceFileId: componentFileId } as any)
          : [];

        // Find API callers in the component's source file
        const callers = componentFileId
          ? store.findNodes('ClientSideAPICaller', { sourceFileId: componentFileId } as any)
          : [];

        // Find navigation targets from this screen's component
        const navEdges = componentFunction
          ? store.findEdges(componentFunction.id, null, 'NAVIGATES_TO')
          : [];
        // Also check all functions in the component file for nav edges
        const fileFunctions = componentFileId
          ? store.findNodes('FunctionDefinition', { sourceFileId: componentFileId } as any)
          : [];
        const allNavEdges = fileFunctions.flatMap((f) =>
          store.findEdges(f.id, null, 'NAVIGATES_TO')
        );
        const uniqueNavTargets = [...new Set([...navEdges, ...allNavEdges].map((e) => e.to))];
        const navTargetScreens = uniqueNavTargets
          .map((id) => store.getNode('Screen', id))
          .filter(Boolean);

        // Find incoming navigation (which screens navigate here)
        const incomingNavEdges = store.findEdges(null, screen.id, 'NAVIGATES_TO');

        return {
          screen: {
            id: screen.id,
            name: screen.name,
            navigatorKind: screen.navigatorKind,
            ...(includeEvidence ? { evidence: screen.evidence ?? null } : {}),
          },
          componentFunction: componentFunction ? {
            id: componentFunction.id,
            name: componentFunction.name,
            sourceLine: componentFunction.sourceLine,
          } : null,
          processes: processes.map((p) => ({
            id: p.id, kind: p.kind, name: p.name, sourceLine: p.sourceLine,
          })),
          apiCalls: callers.map((c) => ({
            id: c.id, httpMethod: c.httpMethod, urlLiteral: c.urlLiteral,
            egressConfidence: c.egressConfidence,
            ...(c.isExternal ? { isExternal: true, externalHost: c.externalHost } : {}),
          })),
          navigatesTo: navTargetScreens.map((s) => s!.name),
          navigatedFrom: incomingNavEdges.map((e) => {
            // Try to find the source function name
            const fn = store.getNode('FunctionDefinition', e.from);
            return fn?.name ?? e.from;
          }),
        };
      });

      return {
        content: [{
          type: 'text' as const,
          // #275 — always return the array shape so consumers don't
          // have to handle two response variants. Single-match is just
          // {screens:[oneScreen]}, predictable, never surprising.
          text: JSON.stringify({ screens: results }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'walk_screen_flows',
    'Walk end-to-end flows for all processes in a named screen. Finds the screen component, collects all its processes (useEffect, onPress, etc.), and walks their flows. Shortcut for mobile developers.',
    {
      screenName: z.string().describe('Screen name as declared in the navigator (e.g., "Login", "Home")'),
      repository: z.string().optional().describe('Scope to a single repository'),
      maxCallDepth: z.number().optional().describe('Max call-graph traversal depth (default: 10)'),
      includeEvidence: z.boolean().optional().describe('Include source code evidence (default: false)'),
      maxHops: z.number().optional().describe('Max service-to-service hops (default: 1)'),
    },
    async ({ screenName, repository, maxCallDepth, includeEvidence, maxHops }) => {
      const repoFilter = repository ? { repository } as any : undefined;
      const screenNodes = store.findNodes('Screen', repoFilter)
        .filter((s) => s.name === screenName);

      if (screenNodes.length === 0) {
        const allScreens = store.findNodes('Screen', repoFilter);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: `No screen named "${screenName}"`,
            code: 'NOT_FOUND',
            hint: 'Use list_nodes type=Screen or list_screens to find valid screen names.',
            availableScreens: allScreens.map((s) => s.name),
          }, null, 2) }],
        };
      }

      const walker = createFlowWalker(store, {
        maxCallDepth: maxCallDepth ?? 10,
        maxHops: maxHops ?? 1,
      });

      const allFlows: Flow[] = [];
      // Screens without a walkable component (#198 PR2): SSG/SSR pages
      // and static HTML have no React/Vue component, so the call-graph
      // walk has nothing to descend into. Pre-#198 PR2 these were
      // silently `continue`-skipped and the user saw `totalFlows: 0`
      // with no explanation. Now we surface them as a separate list
      // so the caller knows the screen exists but is "page-only".
      const screensWithoutFlows: Array<{
        name: string;
        routePath: string | null;
        sourceFileId: string;
        framework: string;
      }> = [];

      for (const screen of screenNodes) {
        // Find the component function
        let componentFnId = screen.componentFunctionId;
        if (!componentFnId) {
          const compEdges = store.findEdges(screen.id, null, 'SCREEN_COMPONENT');
          if (compEdges.length > 0) componentFnId = compEdges[0].to;
        }
        if (!componentFnId) {
          // No component: page-only screen. Surface it with its
          // identity rather than dropping silently.
          screensWithoutFlows.push({
            name: screen.name,
            routePath: screen.routePath ?? null,
            sourceFileId: screen.sourceFileId,
            framework: screen.framework,
          });
          continue;
        }

        // Find the source file of the component
        const componentFn = store.getNode('FunctionDefinition', componentFnId);
        if (!componentFn) continue;
        const sourceFileId = (componentFn as any).sourceFileId;
        if (!sourceFileId) continue;

        // Find all processes in that file
        const processes = store.findNodes('ClientSideProcess', { sourceFileId } as any);

        for (const process of processes) {
          const flows = walker.walkFromProcess(process.id);
          allFlows.push(...flows);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            screenName,
            totalFlows: allFlows.length,
            flows: formatFlows(allFlows, includeEvidence ?? false),
            // Always include this field even when empty so callers can
            // discriminate "screen has no walkable flows" from
            // "screen not found".
            screensWithoutFlows,
          }, null, 2),
        }],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // #126 — Screen-aggregation tools (Phases 1+2+4)
  // ──────────────────────────────────────────────────────────────────

  server.tool(
    'list_screens',
    'Aggregate every Screen with the ClientSideProcess nodes (event handlers, lifecycle hooks) defined in its component, the ClientSideAPICallers triggered by those processes, and the database tables touched. One row per screen. Use as the entry point when an LLM asks "what does this app do" or "what happens on the X screen".',
    {
      repository: z.string().optional().describe('Filter to a single repository'),
      filter: z.string().optional().describe('Match screens whose name OR routePath contains this substring (case-insensitive)'),
    },
    async ({ repository, filter }) => {
      const result = aggregateScreens(store, { repository, filter });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'list_pages',
    'Variant of list_screens that filters to screens with a non-null routePath (web-router and SSG/SSR pages). RN named-only screens are excluded. Returns one row per route, ordered by routePath.',
    {
      repository: z.string().optional().describe('Filter to a single repository'),
    },
    async ({ repository }) => {
      const all = aggregateScreens(store, { repository });
      const pages = all.screens.filter((s) => s.routePath !== null);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            totalPages: pages.length,
            pages: pages.sort((a, b) => (a.routePath ?? '').localeCompare(b.routePath ?? '')),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'screen_impact',
    'Impact analysis scoped to a single screen: what API calls it makes, which DB tables it touches, and which OTHER screens share those tables (i.e., what would also break if the table changed). Pass either screenName or routePath to identify the screen.',
    {
      screenName: z.string().optional().describe('Screen.name to scope the analysis to'),
      routePath: z.string().optional().describe('Screen.routePath to scope the analysis to (alternative to screenName)'),
      repository: z.string().optional().describe('Filter to a single repository'),
    },
    async ({ screenName, routePath, repository }) => {
      if (!screenName && !routePath) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Pass either screenName or routePath',
          }, null, 2) }],
          isError: true,
        };
      }
      const all = aggregateScreens(store, { repository });
      const target = all.screens.find((s) => {
        if (screenName && s.name === screenName) return true;
        if (routePath && s.routePath === routePath) return true;
        return false;
      });
      if (!target) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Screen not found',
            availableScreens: all.screens.map((s) => ({ name: s.name, routePath: s.routePath })),
          }, null, 2) }],
          isError: true,
        };
      }
      // Find which other screens share each of the target's tables.
      const sharedTables: Record<string, string[]> = {};
      for (const tbl of target.tables) {
        const others = all.screens
          .filter((s) => s !== target && s.tables.includes(tbl))
          .map((s) => s.name);
        sharedTables[tbl] = others;
      }
      // 1-hop nav neighborhood — inbound + outbound NAVIGATES_TO from
      // the target screen. Per #248's parasitic-data-capture mechanism,
      // this provides workflow-candidate signal for downstream Phase 3
      // calibration without committing to a full inference algorithm.
      const navEdges = store.findEdges(null, null, 'NAVIGATES_TO');
      const relatedScreens: Array<{ name: string; routePath: string | null; navMethod: string | null; distance: number }> = [];
      const seen = new Set<string>([target.id]);
      for (const e of navEdges.filter((e) => e.from === target.id)) {
        const dst = all.screens.find((s) => s.id === e.to);
        if (dst && !seen.has(dst.id)) {
          seen.add(dst.id);
          relatedScreens.push({ name: dst.name, routePath: dst.routePath ?? null, navMethod: (e as { method?: string }).method ?? null, distance: 1 });
        }
      }
      for (const e of navEdges.filter((e) => e.to === target.id)) {
        const src = all.screens.find((s) => s.id === e.from);
        if (src && !seen.has(src.id)) {
          seen.add(src.id);
          relatedScreens.push({ name: src.name, routePath: src.routePath ?? null, navMethod: (e as { method?: string }).method ?? null, distance: 1 });
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            screen: target,
            sharedTables,
            relatedScreens,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'navigation_graph',
    'Return the screen-to-screen navigation graph as an adjacency list. Optionally find the shortest path between two screens.',
    {
      repository: z.string().optional().describe('Scope to a single repository'),
      fromScreen: z.string().optional().describe('Find shortest navigation path from this screen'),
      toScreen: z.string().optional().describe('Find shortest navigation path to this screen'),
    },
    async ({ repository, fromScreen, toScreen }) => {
      const repoFilter = repository ? { repository } as any : undefined;
      const screenNodes = store.findNodes('Screen', repoFilter);
      const allNavEdges = store.findEdges(null, null, 'NAVIGATES_TO');

      // Build adjacency list: screen name → set of target screen names
      const screenIdToName = new Map<string, string>();
      const adjacency: Record<string, string[]> = {};
      for (const s of screenNodes) {
        screenIdToName.set(s.id, s.name);
        adjacency[s.name] = [];
      }

      // Pre-build sourceFileId → Screen lookups so we don't do an
      // O(screens) scan per nav edge. Two paths (#198 PR2):
      //   1. componentSourceFile: Screen → component fn → component's
      //      source file. Used for RN/SPA screens where the user-code
      //      lives inside a React component.
      //   2. screenSourceFile: Screen → its OWN sourceFileId. Used for
      //      SSG/SSR screens where the Screen is the template/page file
      //      itself and there's no enclosing component function.
      // Component-based map wins on collision (specific > generic).
      const screenByComponentSourceFile = new Map<string, typeof screenNodes[number]>();
      const screenByOwnSourceFile = new Map<string, typeof screenNodes[number]>();
      for (const s of screenNodes) {
        if (s.componentFunctionId) {
          const compFn = store.getNode('FunctionDefinition', s.componentFunctionId);
          if (compFn?.sourceFileId) screenByComponentSourceFile.set(compFn.sourceFileId, s);
        }
        if (s.sourceFileId) screenByOwnSourceFile.set(s.sourceFileId, s);
      }

      for (const edge of allNavEdges) {
        const targetName = screenIdToName.get(edge.to);
        if (!targetName) continue;

        // The edge's `from` can be:
        //   - a FunctionDefinition (the React component's body
        //     contains a `navigate('Screen')` call), or
        //   - a SourceFile (a static template's `<a href="/path">`
        //     resolves to a Screen — emitted by lang-html / framework-
        //     react-router producers in #198 PR3 / #187).
        // Try the FunctionDefinition path first (existing behavior),
        // then fall back to the SourceFile path.
        let sourceScreen: typeof screenNodes[number] | undefined;
        const sourceFn = store.getNode('FunctionDefinition', edge.from);
        if (sourceFn?.sourceFileId) {
          sourceScreen = screenByComponentSourceFile.get(sourceFn.sourceFileId)
            ?? screenByOwnSourceFile.get(sourceFn.sourceFileId);
        }
        if (!sourceScreen) {
          // Try interpreting `from` as a SourceFile id directly. The
          // map lookup is the only thing we need — its presence
          // already proves this is a real SourceFile-keyed Screen.
          // Edges from non-Screen-owning ids gracefully miss.
          sourceScreen = screenByOwnSourceFile.get(edge.from);
        }
        if (sourceScreen && !adjacency[sourceScreen.name]?.includes(targetName)) {
          adjacency[sourceScreen.name]?.push(targetName);
        }
      }

      const result: Record<string, unknown> = {
        totalScreens: screenNodes.length,
        adjacency,
      };

      // Path finding via BFS
      if (fromScreen && toScreen) {
        const path = bfsPath(adjacency, fromScreen, toScreen);
        result.path = path
          ? { from: fromScreen, to: toScreen, hops: path.length - 1, screens: path }
          : { from: fromScreen, to: toScreen, reachable: false };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  server.tool(
    'list_env_vars',
    'List all environment variable accesses found in the source code (process.env.X, import.meta.env.X). Groups by variable name with usage locations.',
    {
      repository: z.string().optional().describe('Scope to a single repository'),
    },
    async ({ repository }) => {
      const repoFilter = repository ? { repository } as any : undefined;
      const envVars = store.findNodes('EnvironmentVariable' as NodeType, repoFilter) as any[];

      // Group by variable name
      type EnvVarUsage = { file: string; line: number; hasDefault: boolean; functionName: string | null };
      const byName = new Map<string, { name: string; category: string; usages: EnvVarUsage[] }>();
      for (const data of envVars) {
        const name = data.name as string;
        const entry = byName.get(name) ?? { name, category: data.category ?? 'unknown', usages: [] as EnvVarUsage[] };
        const sf = store.getNode('SourceFile', data.sourceFileId);
        const fn = data.functionId ? store.getNode('FunctionDefinition', data.functionId) : null;
        entry.usages.push({
          file: sf?.filePath ?? 'unknown',
          line: data.sourceLine ?? 0,
          hasDefault: data.hasDefault ?? false,
          functionName: fn?.name ?? null,
        });
        byName.set(name, entry);
      }

      const sorted = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: sorted.length,
            envVars: sorted,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'list_middleware',
    'List middleware that runs before API endpoints. Aggregates the ordered middleware chain across endpoints, grouped by middleware name, with the endpoints each one protects and the position in the chain.',
    {
      repository: z.string().optional().describe('Scope to a single repository'),
      name: z.string().optional().describe('Filter to middleware whose name contains this substring (case-insensitive)'),
    },
    async ({ repository, name }) => {
      const repoFilter = repository ? { repository } as any : undefined;
      const endpoints = store.findNodes('APIEndpoint', repoFilter);
      const nameFilter = name?.toLowerCase();

      type ProtectedEndpoint = {
        endpointId: string;
        httpMethod: string;
        routePattern: string;
        repository: string;
        framework: string;
        order: number;
      };
      type Aggregate = {
        name: string;
        functionId: string | null;
        sourceFile: string | null;
        sourceLine: number | null;
        protectedEndpoints: ProtectedEndpoint[];
      };

      const byName = new Map<string, Aggregate>();
      for (const ep of endpoints) {
        const chain = ep.middlewareChain ?? [];
        for (const entry of chain) {
          if (nameFilter && !entry.name.toLowerCase().includes(nameFilter)) continue;
          let agg = byName.get(entry.name);
          if (!agg) {
            let sourceFile: string | null = null;
            let sourceLine: number | null = null;
            if (entry.functionId) {
              const fn = store.getNode('FunctionDefinition', entry.functionId);
              if (fn) {
                const sf = store.getNode('SourceFile', fn.sourceFileId);
                sourceFile = sf?.filePath ?? null;
                sourceLine = fn.sourceLine;
              }
            }
            agg = {
              name: entry.name,
              functionId: entry.functionId ?? null,
              sourceFile,
              sourceLine,
              protectedEndpoints: [],
            };
            byName.set(entry.name, agg);
          }
          agg.protectedEndpoints.push({
            endpointId: ep.id,
            httpMethod: ep.httpMethod,
            routePattern: ep.routePattern,
            repository: ep.repository,
            framework: ep.framework,
            order: entry.order,
          });
        }
      }

      const sorted = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: sorted.length,
            totalEndpoints: endpoints.length,
            middleware: sorted,
          }, null, 2),
        }],
      };
    }
  );

  return { server };
}

/**
 * #126 — Per-screen aggregation helper.
 *
 * Walks every Screen in the store, finds the ClientSideProcess nodes
 * that live in its component's source file (or its own sourceFileId
 * for SSG/SSR pages), follows MAKES_REQUEST edges to ClientSideAPICaller
 * nodes for API summaries, and walks RESOLVES_TO_ENDPOINT for endpoints
 * + DB tables touched.
 *
 * Used by `list_screens`, `list_pages`, and `screen_impact`.
 */
interface AggregatedScreen {
  id: string;
  name: string;
  routePath: string | null;
  framework: string;
  sourceFileId: string;
  repository: string;
  processes: Array<{ kind: string; name: string; sourceLine: number }>;
  apiCalls: Array<{ httpMethod: string | null; urlLiteral: string | null }>;
  endpoints: Array<{ httpMethod: string; routePattern: string }>;
  tables: string[];
}

function aggregateScreens(
  store: CanonicalGraphStore,
  opts: { repository?: string; filter?: string } = {},
): { totalScreens: number; screens: AggregatedScreen[] } {
  const repoFilter = opts.repository ? { repository: opts.repository } as never : undefined;
  const screenNodes = store.findNodes('Screen', repoFilter);
  const filterLower = opts.filter?.toLowerCase();

  const out: AggregatedScreen[] = [];
  for (const screen of screenNodes) {
    if (filterLower) {
      const name = screen.name.toLowerCase();
      const route = (screen.routePath ?? '').toLowerCase();
      if (!name.includes(filterLower) && !route.includes(filterLower)) continue;
    }

    // Determine which sourceFile owns this screen's processes.
    let processSourceFileId: string | null = null;
    if (screen.componentFunctionId) {
      const fn = store.getNode('FunctionDefinition', screen.componentFunctionId);
      processSourceFileId = fn?.sourceFileId ?? null;
    }
    if (!processSourceFileId) processSourceFileId = screen.sourceFileId;

    // NOTE: Phase-1 simplification — `processes` is sourceFile-scoped,
    // not component-scoped. Two screens whose components live in the
    // same source file will pick up each other's processes. Rare in
    // practice (each screen typically owns its own file) but worth
    // tightening to functionId-scoped lookup if shared-file layouts
    // become common.
    const processes = processSourceFileId
      ? store.findNodes('ClientSideProcess', { sourceFileId: processSourceFileId } as never)
      : [];

    // Each process can MAKES_REQUEST → ClientSideAPICaller. Some
    // architectures emit the edge from the enclosing function id
    // instead of from the process itself; handle both.
    const callerIds = new Set<string>();
    for (const p of processes) {
      for (const e of store.findEdges(p.id, null, 'MAKES_REQUEST')) {
        callerIds.add(e.to);
      }
      for (const e of store.findEdges(p.functionId, null, 'MAKES_REQUEST')) {
        callerIds.add(e.to);
      }
    }
    const callers = [...callerIds]
      .map((id) => store.getNode('ClientSideAPICaller', id))
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // Each caller can RESOLVES_TO_ENDPOINT → APIEndpoint → tables via
    // PERFORMED_BY → DatabaseInteraction → READS/WRITES.
    const endpointIds = new Set<string>();
    for (const c of callers) {
      for (const e of store.findEdges(c.id, null, 'RESOLVES_TO_ENDPOINT')) {
        endpointIds.add(e.to);
      }
    }
    const endpoints = [...endpointIds]
      .map((id) => store.getNode('APIEndpoint', id))
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const tableSet = new Set<string>();
    for (const ep of endpoints) {
      if (!ep.handlerFunctionId) continue;
      const callsEdges = store.findEdges(null, ep.handlerFunctionId, 'PERFORMED_BY');
      for (const ce of callsEdges) {
        const interaction = store.getNode('DatabaseInteraction', ce.from);
        if (!interaction) continue;
        for (const re of store.findEdges(interaction.id, null, 'READS')) {
          const t = store.getNode('DatabaseTable', re.to);
          if (t) tableSet.add(t.name);
        }
        for (const we of store.findEdges(interaction.id, null, 'WRITES')) {
          const t = store.getNode('DatabaseTable', we.to);
          if (t) tableSet.add(t.name);
        }
      }
    }

    out.push({
      id: screen.id,
      name: screen.name,
      routePath: screen.routePath ?? null,
      framework: screen.framework,
      sourceFileId: screen.sourceFileId,
      repository: screen.repository,
      processes: processes.map((p) => ({ kind: p.kind, name: p.name, sourceLine: p.sourceLine })),
      apiCalls: callers.map((c) => ({ httpMethod: c.httpMethod, urlLiteral: c.urlLiteral })),
      endpoints: endpoints.map((e) => ({ httpMethod: e.httpMethod, routePattern: e.routePattern })),
      tables: [...tableSet].sort(),
    });
  }

  return { totalScreens: out.length, screens: out };
}

/** BFS shortest path between two screen names in an adjacency list. */
function bfsPath(adjacency: Record<string, string[]>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  if (!adjacency[from]) return null;
  const visited = new Set<string>([from]);
  const queue: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }];
  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    for (const neighbor of adjacency[node] ?? []) {
      if (neighbor === to) return [...path, neighbor];
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push({ node: neighbor, path: [...path, neighbor] });
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Recursively strip `evidence` and `snippet` fields from objects to
 * reduce response size. These two fields are the largest contributors
 * to payload size (~200-500 chars each per node). Evidence is opt-in —
 * callers must pass `includeEvidence: true` to see it.
 */
function stripVerboseFields(data: unknown): unknown {
  if (data === null || data === undefined || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(stripVerboseFields);
  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'evidence' || key === 'snippet') continue;
    result[key] = stripVerboseFields(value);
  }
  return result;
}

/**
 * #276 — drop top-level keys whose value is null, undefined, or an
 * empty array. Used by list_incomplete_flows to halve the payload
 * size: incomplete flows by definition have null endpoint /
 * matchConfidence / matchedBy / handlerFunction and empty
 * databaseHops / serviceHops / responses / responseHandlers.
 *
 * Conservative — only top-level. Nested objects keep their shape so
 * we don't accidentally drop meaningful nullable fields a few levels
 * down.
 */
function stripNullishFields<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return result as Partial<T>;
}

/**
 * Simplify flow objects for JSON output. The full `Flow` type has
 * deeply-nested schema nodes; for the MCP response we flatten it
 * into a more readable shape that an AI agent can reason about.
 */
function formatFlows(flows: Flow[], includeEvidence = false) {
  return flows.map((flow) => ({
    completeness: flow.completeness,
    startProcess: flow.startProcess
      ? {
          id: flow.startProcess.id,
          kind: flow.startProcess.kind,
          name: flow.startProcess.name,
          sourceLine: flow.startProcess.sourceLine,
          ...(includeEvidence ? { evidence: flow.startProcess.evidence ?? null } : {}),
        }
      : null,
    caller: flow.caller
      ? {
          id: flow.caller.id,
          httpMethod: flow.caller.httpMethod,
          urlLiteral: flow.caller.urlLiteral,
          egressConfidence: flow.caller.egressConfidence,
          ...(flow.caller.isExternal ? { isExternal: true, externalHost: flow.caller.externalHost } : {}),
          ...(includeEvidence ? { evidence: flow.caller.evidence ?? null } : {}),
        }
      : null,
    matchConfidence: flow.matchConfidence,
    matchedBy: flow.matchedBy,
    endpoint: flow.endpoint
      ? {
          id: flow.endpoint.id,
          httpMethod: flow.endpoint.httpMethod,
          routePattern: flow.endpoint.routePattern,
          framework: flow.endpoint.framework,
          ...(includeEvidence ? { evidence: flow.endpoint.evidence ?? null } : {}),
        }
      : null,
    handlerFunction: flow.handlerFunction
      ? {
          id: flow.handlerFunction.id,
          name: flow.handlerFunction.name,
          ...(includeEvidence ? { evidence: flow.handlerFunction.evidence ?? null } : {}),
        }
      : null,
    databaseHops: flow.databaseHops.map((hop) => ({
      operation: hop.interaction.operation,
      orm: hop.interaction.orm,
      confidence: hop.interaction.confidence,
      readsTable: hop.readsTable?.name ?? null,
      writesTable: hop.writesTable?.name ?? null,
      readsTables: hop.readsTables.map((t) => t.name),
      writesTables: hop.writesTables.map((t) => t.name),
      ...(includeEvidence ? { evidence: hop.interaction.evidence ?? null } : {}),
    })),
    serviceHops: flow.serviceHops.length > 0 ? formatServiceHops(flow.serviceHops, includeEvidence) : [],
    navigationTargets: flow.navigationTargets.length > 0
      ? flow.navigationTargets.map((nt) => ({
          screenName: nt.screen.name,
          navigatorKind: nt.screen.navigatorKind,
          methods: nt.methods,
          componentFunction: nt.componentFunction?.name ?? null,
        }))
      : [],
    responses: includeEvidence ? flow.responses : flow.responses.map(({ sourceLine, ...rest }) => rest),
    responseHandlers: flow.responseHandlers,
  }));
}

/** Check if a flow touches a table, including via service hops. */
function flowTouchesTable(flow: Flow, tableName: string): boolean {
  const hopsTouch = (hops: import('@veoable/flow-stitcher').FlowDatabaseHop[]) =>
    hops.some((hop) =>
      hop.readsTables.some((t) => t.name === tableName) ||
      hop.writesTables.some((t) => t.name === tableName)
    );
  if (hopsTouch(flow.databaseHops)) return true;
  const checkServiceHops = (sh: ServiceHop[]): boolean =>
    sh.some((h) => hopsTouch(h.databaseHops) || checkServiceHops(h.downstreamCalls));
  return checkServiceHops(flow.serviceHops);
}

function formatServiceHops(hops: ServiceHop[], includeEvidence: boolean): unknown[] {
  return hops.map((hop) => ({
    repository: hop.repository,
    caller: {
      httpMethod: hop.caller.httpMethod,
      urlLiteral: hop.caller.urlLiteral,
    },
    endpoint: {
      httpMethod: hop.endpoint.httpMethod,
      routePattern: hop.endpoint.routePattern,
      framework: hop.endpoint.framework,
    },
    handlerFunction: hop.handlerFunction
      ? { name: hop.handlerFunction.name }
      : null,
    databaseHops: hop.databaseHops.map((dbHop) => ({
      operation: dbHop.interaction.operation,
      orm: dbHop.interaction.orm,
      readsTables: dbHop.readsTables.map((t) => t.name),
      writesTables: dbHop.writesTables.map((t) => t.name),
      ...(includeEvidence ? { evidence: dbHop.interaction.evidence ?? null } : {}),
    })),
    downstreamCalls: hop.downstreamCalls.length > 0
      ? formatServiceHops(hop.downstreamCalls, includeEvidence)
      : [],
  }));
}

/**
 * #339 — Lazy SourceFile index keyed on the store instance. The
 * MCP server is read-only after the DB is built. See rest-server.ts
 * for the parallel REST-surface implementation.
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
