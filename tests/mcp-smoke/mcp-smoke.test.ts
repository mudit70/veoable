import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { createMcpServer } from '@veoable/mcp-server';

/**
 * #270 — MCP smoke-and-shape harness.
 *
 * For every tool the MCP server registers, runs at least one positive and
 * (where applicable) one negative scenario against a real graph DB, then
 * writes a markdown report under `tests/mcp-smoke/reports/`. The harness
 * is skipped by default — set MCP_SMOKE_DB to enable. See README.md.
 */

const MCP_SMOKE_DB = process.env.MCP_SMOKE_DB;
const MCP_SMOKE_PROJECT_CONFIG = process.env.MCP_SMOKE_PROJECT_CONFIG;

// ──────────────────────────────────────────────────────────────────────
// Harness state — shared across the full sweep
// ──────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  tool: string;
  scenario: string;
  status: 'pass' | 'fail';
  request: Record<string, unknown>;
  responseShape: 'ok' | 'error' | 'malformed';
  responseHighlights?: Record<string, unknown>;
  notes?: string;
}

interface Finding {
  severity: 'bug' | 'warn' | 'info';
  tool: string;
  scenario: string;
  note: string;
}

const results: ScenarioResult[] = [];
const findings: Finding[] = [];
let advertisedToolCount = 0;

// Harvested-at-startup ids/names used as positive-scenario inputs.
interface HarvestedIds {
  repositories: string[];
  sourceFiles: Array<{ id: string; filePath: string; repository: string }>;
  endpoints: Array<{ id: string; routePattern: string; httpMethod: string; repository: string }>;
  callers: Array<{ id: string; sourceUrl: string }>;
  processes: Array<{ id: string; trigger: string }>;
  screens: Array<{ id: string; name: string }>;
  tables: Array<{ id: string; name: string }>;
  functions: Array<{ id: string; name: string }>;
}

let store: SQLiteCanonicalGraphStore;
let client: Client;
let tmpDbPath: string;
let harvested: HarvestedIds;

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function runScenario(
  tool: string,
  scenario: string,
  args: Record<string, unknown>,
  options?: {
    expectError?: boolean;
    parseHighlights?: (parsed: unknown) => Record<string, unknown> | undefined;
  },
): Promise<void> {
  const expectError = options?.expectError ?? false;
  let status: ScenarioResult['status'] = 'fail';
  let responseShape: ScenarioResult['responseShape'] = 'malformed';
  let highlights: Record<string, unknown> | undefined;
  let notes: string | undefined;

  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    const isError = result.isError === true;

    if (!Array.isArray(content) || content.length === 0) {
      notes = 'response has no content array';
      responseShape = 'malformed';
    } else if (isError && expectError) {
      // Negative scenario worked as designed.
      let parsedError: { error?: string; code?: string } | null = null;
      try {
        parsedError = JSON.parse(content[0].text);
      } catch { /* tolerate */ }
      if (parsedError?.code) {
        status = 'pass';
        responseShape = 'error';
        highlights = { errorCode: parsedError.code };
      } else if (/Invalid arguments for tool/.test(content[0].text)) {
        // SDK-level zod validation rejected the bad input BEFORE our
        // handler ran. That's expected; our `errorResponse()` contract
        // applies to handler-level errors only. Still a pass for the
        // negative scenario. The match is anchored to the SDK's exact
        // phrasing ("Invalid arguments for tool <name>") so a handler
        // that returns a generic "expected X" string doesn't get
        // silently classified as an SDK validation error.
        status = 'pass';
        responseShape = 'error';
        highlights = { errorKind: 'sdk-validation' };
      } else {
        status = 'fail';
        responseShape = 'error';
        notes = 'error response missing structured { code } body';
        findings.push({
          severity: 'bug',
          tool,
          scenario,
          note: 'expected error response, got error but without a structured code field',
        });
      }
    } else if (isError && !expectError) {
      let parsedError: { error?: string; code?: string } | null = null;
      try {
        parsedError = JSON.parse(content[0].text);
      } catch { /* tolerate */ }
      responseShape = 'error';
      notes = `unexpected error: ${parsedError?.error ?? content[0].text.slice(0, 120)}`;
      findings.push({
        severity: 'bug',
        tool,
        scenario,
        note: `positive scenario returned isError: ${parsedError?.error ?? '(unparseable)'}`,
      });
    } else if (!isError && expectError) {
      responseShape = 'ok';
      notes = 'expected error, got success';
      findings.push({
        severity: 'bug',
        tool,
        scenario,
        note: 'negative scenario returned success instead of an error contract',
      });
    } else {
      // Happy path — positive scenario, no isError.
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(content[0].text);
      } catch {
        // Some tools (describe_skill) return raw text. That's a valid
        // shape too — capture the size as a highlight.
        parsed = null;
        highlights = { rawTextChars: content[0].text.length };
      }
      if (parsed !== null && options?.parseHighlights) {
        highlights = options.parseHighlights(parsed);
      } else if (parsed !== null && !highlights) {
        // Default: surface array length / object keys for visibility.
        if (Array.isArray(parsed)) {
          highlights = { items: parsed.length };
        } else if (typeof parsed === 'object') {
          highlights = { keys: Object.keys(parsed as Record<string, unknown>).length };
        }
      }
      status = 'pass';
      responseShape = 'ok';
    }
  } catch (err) {
    responseShape = 'malformed';
    notes = `threw: ${err instanceof Error ? err.message : String(err)}`;
    findings.push({
      severity: 'bug',
      tool,
      scenario,
      note: `transport / protocol error: ${notes}`,
    });
  }

  results.push({ tool, scenario, status, request: args, responseShape, responseHighlights: highlights, notes });
}

function harvestIds(s: SQLiteCanonicalGraphStore): HarvestedIds {
  // Limit to first ~10 of each so the harness doesn't drown if the
  // graph is huge.
  const TAKE = 10;
  const take = <T>(arr: T[]): T[] => arr.slice(0, TAKE);

  return {
    repositories: s.listRepositories().map((r) => r.repository),
    sourceFiles: take(s.findNodes('SourceFile') as Array<{ id: string; filePath: string; repository: string }>),
    endpoints: take(s.findNodes('APIEndpoint') as Array<{ id: string; routePattern: string; httpMethod: string; repository: string }>),
    callers: take(s.findNodes('ClientSideAPICaller') as Array<{ id: string; sourceUrl: string }>),
    processes: take(s.findNodes('ClientSideProcess') as Array<{ id: string; trigger: string }>),
    screens: take(s.findNodes('Screen') as Array<{ id: string; name: string }>),
    tables: take(s.findNodes('DatabaseTable') as Array<{ id: string; name: string }>),
    functions: take(s.findNodes('FunctionDefinition') as Array<{ id: string; name: string }>),
  };
}

function writeReport(reportPath: string): void {
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.length - pass;
  const exercisedTools = new Set(results.map((r) => r.tool)).size;

  const lines: string[] = [];
  lines.push('# MCP server smoke-test report');
  lines.push('');
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Graph: \`${MCP_SMOKE_DB}\` (copied to ${tmpDbPath})`);
  lines.push('');
  if (MCP_SMOKE_PROJECT_CONFIG) {
    lines.push(`Project config: \`${MCP_SMOKE_PROJECT_CONFIG}\``);
    lines.push('');
  }
  lines.push(`Tools advertised by tools/list: **${advertisedToolCount}**`);
  lines.push(`Tools exercised: **${exercisedTools}**`);
  lines.push(`Total scenarios run: **${results.length}**`);
  lines.push(`Pass / fail: **${pass} / ${fail}**`);
  lines.push('');
  lines.push('## A. Tool coverage');
  lines.push('');
  lines.push('| Tool | Scenario | Status | Highlights | Notes |');
  lines.push('|------|----------|--------|------------|-------|');
  for (const r of results) {
    const highlights = r.responseHighlights ? '`' + JSON.stringify(r.responseHighlights) + '`' : '';
    const notes = r.notes ?? '';
    lines.push(`| \`${r.tool}\` | ${r.scenario} | ${r.status} | ${highlights} | ${notes} |`);
  }
  lines.push('');
  lines.push('## B. Findings');
  lines.push('');
  if (findings.length === 0) {
    lines.push('No findings. All scenarios passed cleanly.');
  } else {
    lines.push('| Severity | Tool | Scenario | Note |');
    lines.push('|----------|------|----------|------|');
    for (const f of findings) {
      lines.push(`| ${f.severity} | \`${f.tool}\` | ${f.scenario} | ${f.note} |`);
    }
  }
  lines.push('');
  lines.push('## C. Harvested fixture inventory');
  lines.push('');
  lines.push(`- Repositories: ${harvested.repositories.length} — ${harvested.repositories.slice(0, 8).join(', ')}${harvested.repositories.length > 8 ? ', …' : ''}`);
  lines.push(`- SourceFiles (sampled): ${harvested.sourceFiles.length}`);
  lines.push(`- APIEndpoints (sampled): ${harvested.endpoints.length}`);
  lines.push(`- ClientSideAPICallers (sampled): ${harvested.callers.length}`);
  lines.push(`- ClientSideProcesses (sampled): ${harvested.processes.length}`);
  lines.push(`- Screens (sampled): ${harvested.screens.length}`);
  lines.push(`- DatabaseTables (sampled): ${harvested.tables.length}`);
  lines.push(`- FunctionDefinitions (sampled): ${harvested.functions.length}`);
  lines.push('');

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────
// Test
// ──────────────────────────────────────────────────────────────────────

describe.skipIf(!MCP_SMOKE_DB)('MCP smoke harness (#270)', () => {
  beforeAll(async () => {
    if (!MCP_SMOKE_DB) return;
    if (!fs.existsSync(MCP_SMOKE_DB)) {
      throw new Error(`MCP_SMOKE_DB does not exist: ${MCP_SMOKE_DB}`);
    }
    // Copy the graph to a temp file so the harness can mutate freely
    // (stitch, add_stitch_rule, etc.) without disturbing the user's
    // real DB.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-'));
    tmpDbPath = path.join(tmpDir, path.basename(MCP_SMOKE_DB));
    fs.copyFileSync(MCP_SMOKE_DB, tmpDbPath);
    // Copy WAL/SHM if they exist so the working set is complete.
    for (const suffix of ['-wal', '-shm']) {
      const src = MCP_SMOKE_DB + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, tmpDbPath + suffix);
      }
    }

    store = new SQLiteCanonicalGraphStore(tmpDbPath);
    harvested = harvestIds(store);
    // Derive projectRoot from the env var, then from the project config
    // dir. Without this, get_source_file errors out with "requires
    // --project-root". The fallback is correct only when the project
    // config lives at the source-tree root — for in-repo example
    // configs (which live in examples/ but point at code elsewhere),
    // set MCP_SMOKE_PROJECT_ROOT explicitly. We warn when defaulting so
    // a wrong root doesn't silently downgrade get_source_file coverage.
    let projectRoot: string | undefined;
    if (process.env.MCP_SMOKE_PROJECT_ROOT) {
      projectRoot = process.env.MCP_SMOKE_PROJECT_ROOT;
    } else if (MCP_SMOKE_PROJECT_CONFIG) {
      projectRoot = path.dirname(MCP_SMOKE_PROJECT_CONFIG);
      console.warn(
        `[mcp-smoke] MCP_SMOKE_PROJECT_ROOT not set; defaulting to ${projectRoot}. ` +
        'This is wrong if the config lives apart from the source tree.',
      );
    }
    const { server } = createMcpServer(store, {
      projectConfigPath: MCP_SMOKE_PROJECT_CONFIG,
      projectRoot,
      dbPath: tmpDbPath,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'mcp-smoke-harness', version: '0.0.1' });
    await client.connect(clientTransport);
  }, 30_000);

  afterAll(async () => {
    if (!MCP_SMOKE_DB) return;
    // Write the report regardless of pass/fail so the user can inspect
    // findings.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.resolve(__dirname, 'reports', `${stamp}.md`);
    writeReport(reportPath);
    console.error(`Wrote MCP smoke report → ${reportPath}`);
    if (client) await client.close();
    if (store) store.close();
  });

  it('every registered tool is exercised at least once', async () => {
    const list = await client.listTools();
    advertisedToolCount = list.tools.length;

    // ── Inventory / orientation ──────────────────────────────────
    await runScenario('describe_skill', 'positive: returns SKILL.md', {});
    await runScenario('list_repositories', 'positive: enumerate repos', {}, {
      parseHighlights: (p) => ({ repositories: (p as { repositories?: unknown[] }).repositories?.length ?? 0 }),
    });
    await runScenario('stats', 'positive: global stats', {});
    if (harvested.repositories[0]) {
      await runScenario('stats', `positive: scoped to ${harvested.repositories[0]}`, {
        repository: harvested.repositories[0],
      });
    }
    await runScenario('describe_architecture', 'positive: project overview', {});

    // ── Graph primitives ─────────────────────────────────────────
    await runScenario('list_nodes', 'positive: SourceFile', { nodeType: 'SourceFile' });
    await runScenario('list_nodes', 'positive: APIEndpoint countOnly', { nodeType: 'APIEndpoint', countOnly: true });
    await runScenario('list_nodes', 'negative: bogus nodeType', { nodeType: 'NotARealType' }, { expectError: true });
    if (harvested.sourceFiles[0]) {
      await runScenario('get_node', 'positive: real SourceFile', {
        nodeType: 'SourceFile',
        id: harvested.sourceFiles[0].id,
      });
    }
    await runScenario('get_node', 'negative: nonexistent id', {
      nodeType: 'SourceFile',
      id: 'SourceFile:0000000000000000',
    }, { expectError: true });
    if (harvested.sourceFiles[0]) {
      await runScenario('find_edges', 'positive: outbound edges of SourceFile', {
        from: harvested.sourceFiles[0].id,
      });
    }
    await runScenario('find_edges', 'positive: all IMPORTS edges', { edgeType: 'IMPORTS' });

    if (harvested.sourceFiles[0]) {
      const fp = harvested.sourceFiles[0].filePath;
      await runScenario('describe_file', `positive: ${fp}`, { filePath: fp });
      await runScenario('get_source_file', `positive: ${fp}`, { filePath: fp });
    }

    // ── API surface ─────────────────────────────────────────────
    await runScenario('list_server_endpoints', 'positive: global', {});
    if (harvested.repositories[0]) {
      await runScenario('list_server_endpoints', `positive: scoped to ${harvested.repositories[0]}`, {
        repository: harvested.repositories[0],
      });
    }
    await runScenario('list_client_api_calls', 'positive: global', {});
    await runScenario('list_unmatched_callers', 'positive', {});
    await runScenario('list_uncalled_endpoints', 'positive', {});
    await runScenario('list_incomplete_flows', 'positive', {});
    await runScenario('list_middleware', 'positive', {});
    await runScenario('list_env_vars', 'positive', {});

    // ── Flow walking ─────────────────────────────────────────────
    if (harvested.processes[0]) {
      await runScenario('walk_flows', 'positive: real processId', {
        processId: harvested.processes[0].id,
      });
    }
    await runScenario('walk_flows', 'negative: nonexistent processId', {
      processId: 'ClientSideProcess:0000000000000000',
    }, { expectError: true });
    await runScenario('walk_all_flows', 'positive: countOnly', { countOnly: true });

    // ── Screen / mobile tools ────────────────────────────────────
    await runScenario('list_screens', 'positive', {});
    await runScenario('list_pages', 'positive', {});
    if (harvested.screens[0]) {
      await runScenario('describe_screen', `positive: ${harvested.screens[0].name}`, {
        screenName: harvested.screens[0].name,
      });
      await runScenario('walk_screen_flows', `positive: ${harvested.screens[0].name}`, {
        screenName: harvested.screens[0].name,
      });
      await runScenario('screen_impact', `positive: ${harvested.screens[0].name}`, {
        screenName: harvested.screens[0].name,
      });
    }
    await runScenario('describe_screen', 'negative: nonexistent screen', {
      screenName: 'NoSuchScreenXyz123',
    }, { expectError: true });
    await runScenario('navigation_graph', 'positive', {});
    await runScenario('list_unreachable_screens', 'positive', {});
    await runScenario('list_orphan_tables', 'positive', {});

    // ── Impact + diff ────────────────────────────────────────────
    if (harvested.endpoints[0]) {
      await runScenario('impact_analysis', `positive: endpoint ${harvested.endpoints[0].routePattern}`, {
        routePattern: harvested.endpoints[0].routePattern,
      });
    }
    if (harvested.tables[0]) {
      await runScenario('impact_analysis', `positive: table ${harvested.tables[0].name}`, {
        tableName: harvested.tables[0].name,
      });
    }
    if (harvested.sourceFiles[0]) {
      await runScenario('diff_flows', 'positive: real changed files', {
        changedFiles: [harvested.sourceFiles[0].filePath],
      });
    }
    await runScenario('diff_flows', 'negative: no matching files', {
      changedFiles: ['definitely/not/a/real/file.zz'],
    });

    // ── Stitching ────────────────────────────────────────────────
    // Order matters here: `stitch` has no dryRun option and commits
    // RESOLVES_TO_ENDPOINT edges to the temp DB. Anything that wants
    // to assert pre-stitch shape must run BEFORE this block; anything
    // after sees the post-stitch graph. Today the only read-only
    // tools that care about RESOLVES_TO_ENDPOINT counts
    // (list_uncalled_endpoints, list_unmatched_callers,
    // list_incomplete_flows) run earlier in the sweep.
    await runScenario('stitch_report', 'positive', {});
    await runScenario('suggest_stitches', 'positive', {});
    await runScenario('stitch', 'positive: idempotent', {});
    await runScenario('auto_stitch', 'positive: dryRun', { dryRun: true, minConfidence: 'deterministic' });
    await runScenario('apply_stitch_rules', 'positive', {});
    await runScenario('ai_stitch_review', 'positive', {});
    if (MCP_SMOKE_PROJECT_CONFIG && harvested.repositories.length >= 2) {
      await runScenario('add_stitch_rule', 'positive: dryRun', {
        name: 'smoke-test-stitch-rule',
        from: harvested.repositories[0],
        to: harvested.repositories[1],
        transformType: 'stripPrefix',
        prefix: '/v0/smoke/',
        dryRun: true,
      });
    }

    // ── Cross-tool consistency ──────────────────────────────────
    // Confirm: ids returned by findNodes() round-trip via the MCP
    // get_node tool. This catches "tool returns ids the rest of the
    // graph doesn't know about" bugs. We check two node types — the
    // most-asked-about (APIEndpoint) and the most bug-prone per prior
    // smoke runs (Screen, see #267).
    const roundTrip = async (nodeType: string, id: string): Promise<void> => {
      const r = await client.callTool({
        name: 'get_node',
        arguments: { nodeType, id },
      });
      const ok = !(r.isError === true);
      if (!ok) {
        findings.push({
          severity: 'bug',
          tool: 'cross-tool',
          scenario: `get_node resolves a ${nodeType} id from harvest`,
          note: `id ${id} from findNodes did not round-trip through get_node`,
        });
      }
      results.push({
        tool: 'cross-tool',
        scenario: `${nodeType} id round-trips through get_node`,
        status: ok ? 'pass' : 'fail',
        request: { nodeType, id },
        responseShape: ok ? 'ok' : 'error',
      });
    };
    if (harvested.endpoints[0]) {
      await roundTrip('APIEndpoint', harvested.endpoints[0].id);
    }
    if (harvested.screens[0]) {
      await roundTrip('Screen', harvested.screens[0].id);
    }

    // Final assertion: every result has a status; positive scenarios
    // must be 'pass' (negative scenarios are expected to be 'pass' too
    // because the harness flips the assertion for `expectError`).
    const failed = results.filter((r) => r.status === 'fail');
    expect(failed, `${failed.length} scenarios failed; see findings table in the report`).toHaveLength(0);
  }, 120_000);
});
