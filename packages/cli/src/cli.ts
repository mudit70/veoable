#!/usr/bin/env node

import { ensureHeap } from './heap-bump.js';
// Bump V8 heap before the rest of the CLI loads — V8 can't resize
// the old-space heap after process start, so we have to do this
// before any framework plugin or ts-morph state lands. Programmatic
// imports of cli.ts (tests, library consumers) are no-ops; see
// heap-bump.ts for the gating logic.
ensureHeap();

import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyze } from './analyze.js';
import { formatJson, formatText } from './format.js';

/**
 * CLI entry point for Adorable.
 *
 * Usage:
 *   adorable analyze <path> [options]
 *
 * Options:
 *   --output, -o <file>     Write SQLite graph to disk (default: :memory:)
 *   --format <text|json>    Output format (default: text)
 *   --max-call-depth <n>    Max call-graph traversal depth (default: 10)
 *   --exclude <pattern>     Additional directory names to exclude
 *   --verbose, -v           Show per-file extraction progress
 *   --help, -h              Show this help
 */

export interface CliArgs {
  command: string;
  projectPath: string;
  output: string;
  format: 'text' | 'json';
  maxCallDepth: number;
  exclude: string[];
  verbose: boolean;
  help: boolean;
  projectRoot: string;
  stitchMode: 'none' | 'auto-exact' | 'auto-all';
  repoName: string;
  clean: boolean;
  fresh: boolean;
  incremental: boolean;
  rest: boolean;
  transport: 'stdio' | 'http';
  port: number;
  llm: string;
  model: string;
  apiKey: string;
  /**
   * Shortcut for `--llm <known-url>`. Recognized values: 'openrouter',
   * 'openai', 'anthropic', 'local'. Resolves to the canonical base URL
   * for that provider's chat-completions endpoint. Explicit --llm wins.
   */
  provider: string;
  projectConfig: string;
  /** Path to a graph DB. Used by `adorable install <client> --db <path>`. */
  db: string;
  /** Auto-detect every installed LLM client + install into each. */
  auto: boolean;
  /**
   * Path(s) to JSONL trace file(s) produced by `@veoable/trace`'s
   * test-bootstrap hook. The analyze pass reads each file and
   * materializes runtime-observed fetch/axios edges as
   * `ClientSideAPICaller` + `MAKES_REQUEST` nodes/edges with
   * `framework: 'trace'` and `egressConfidence: 'pattern'`. The
   * evidence snippet records `runtime trace: METHOD URL` so MCP
   * queries can surface the provenance. Repeated `--merge-trace`
   * accumulates; trace edges with no matching SourceFile are
   * counted as `unattributable` and silently dropped.
   */
  mergeTrace: string[];
}

/** @internal Exported for testing only. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: '',
    projectPath: '.',
    output: ':memory:',
    format: 'text',
    maxCallDepth: 10,
    exclude: [],
    verbose: false,
    help: false,
    projectRoot: '',
    stitchMode: 'auto-exact',
    repoName: '',
    clean: false,
    fresh: false,
    incremental: false,
    rest: false,
    transport: 'stdio',
    port: 3001,
    llm: 'http://localhost:11434',
    model: 'llama3',
    provider: '',
    projectConfig: '',
    apiKey: '',
    db: '',
    auto: false,
    mergeTrace: [],
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--output':
      case '-o':
        args.output = argv[++i] ?? ':memory:';
        break;
      case '--format':
        args.format = (argv[++i] ?? 'text') as 'text' | 'json';
        break;
      case '--max-call-depth':
        args.maxCallDepth = parseInt(argv[++i] ?? '10', 10);
        break;
      case '--exclude':
        args.exclude.push(argv[++i] ?? '');
        break;
      case '--project-root':
        args.projectRoot = argv[++i] ?? '';
        break;
      case '--stitch-mode':
        args.stitchMode = (argv[++i] ?? 'auto-exact') as 'none' | 'auto-exact' | 'auto-all';
        break;
      case '--repo-name':
        args.repoName = argv[++i] ?? '';
        break;
      case '--clean':
        args.clean = true;
        break;
      case '--fresh':
        args.fresh = true;
        break;
      case '--incremental':
        args.incremental = true;
        break;
      case '--rest':
        args.rest = true;
        break;
      case '--transport': {
        const val = argv[++i] ?? 'stdio';
        if (val !== 'stdio' && val !== 'http') {
          console.error(`Invalid --transport value: ${val}. Must be 'stdio' or 'http'.`);
          process.exit(1);
        }
        args.transport = val;
        break;
      }
      case '--port':
        args.port = parseInt(argv[++i] ?? '3001', 10);
        break;
      case '--llm':
        args.llm = argv[++i] ?? 'http://localhost:11434';
        break;
      case '--provider':
        args.provider = argv[++i] ?? '';
        break;
      case '--model':
        args.model = argv[++i] ?? 'llama3';
        break;
      case '--api-key':
        args.apiKey = argv[++i] ?? '';
        break;
      case '--project-config':
        args.projectConfig = argv[++i] ?? '';
        break;
      case '--db':
        args.db = argv[++i] ?? '';
        break;
      case '--auto':
        args.auto = true;
        break;
      case '--merge-trace': {
        const val = argv[++i];
        if (val) args.mergeTrace.push(val);
        break;
      }
      default:
        if (!arg.startsWith('-')) {
          positional.push(arg);
        }
        break;
    }
  }

  args.command = positional[0] ?? '';
  args.projectPath = positional[1] ?? '.';

  return args;
}

/** Top-level help — concise overview of all commands. */
function printOverview(): void {
  console.log(`
Adorable — end-to-end flow analysis for AI-written code

Usage:
  adorable <command> [args] [options]
  adorable <command> --help        Show command-specific help

Commands:
  analyze <path>           Analyze a project and print end-to-end flows
  serve <graph.db>         Start an MCP or REST server backed by a graph
  chat <graph.db>          Interactive chat with an LLM using the graph as context
  project init <path>      Initialize a multi-repo project config
  project analyze <conf>   Analyze every repo in a project config
  tools                    List MCP tools available to LLMs / clients
  install <client|--auto>  Install Adorable as a skill in an LLM client (claude-code, cursor, continue, vscode, --auto)

Quick start:
  adorable analyze ./my-project --output graph.db
  adorable serve graph.db
  adorable chat graph.db --model anthropic/claude-sonnet-4 --api-key …

Run \`adorable <command> --help\` for command-specific options and examples.
`);
}

function printAnalyzeHelp(): void {
  console.log(`
adorable analyze <path> — Analyze a project and print end-to-end flows.

Usage:
  adorable analyze <path> [options]

Options:
  --output, -o <file>     Write SQLite graph to disk (default: in-memory only)
  --format <text|json>    Output format (default: text)
  --max-call-depth <n>    Max call-graph traversal depth (default: 10)
  --stitch-mode <mode>    Stitching mode: none, auto-exact (default), auto-all
  --repo-name <name>      Override repository name (default: directory name)
  --clean                 Delete existing nodes for this repo before re-analyzing
  --fresh                 Delete the entire output database before starting
  --exclude <pattern>     Additional directory names to exclude (repeatable)
  --verbose, -v           Show per-file extraction progress
  --help, -h              Show this help

Examples:
  adorable analyze .
  adorable analyze ./my-project --output graph.db --verbose
  adorable analyze . --format json > flows.json
  adorable analyze ./api --output project.db --repo-name api --clean

Environment:
  ADORABLE_HEAP_MB        V8 old-space heap budget in MB (default: 8192).
                          adorable respawns node with --max-old-space-size
                          set to this value the first time the CLI starts,
                          unless NODE_OPTIONS already declares a heap flag.
  ADORABLE_NO_HEAP_BUMP   Set to "1" to opt out of the auto heap bump and
                          use whatever heap node was started with.
  NODE_OPTIONS            If this already contains --max-old-space-size,
                          adorable respects it and skips the auto bump.
`);
}

function printServeHelp(): void {
  console.log(`
adorable serve <graph.db> — Start an MCP or REST server backed by a pre-built graph.

Usage:
  adorable serve <graph.db> [options]

Options:
  --project-root <path>   Project root for source file retrieval (default: graph.db parent dir)
  --project-config <path> Project config file (enables stitch rules from config)
  --rest                  Run as a REST API instead of an MCP server
  --transport <mode>      MCP transport: stdio (default) or http
  --port <n>              Port for REST/HTTP server (default: 3001)
  --help, -h              Show this help

Server modes (mutually exclusive):
  MCP / stdio (default)   For Claude Code, Cursor, Windsurf, etc. — MCP over stdin/stdout
  MCP / http              --transport http — StreamableHTTP MCP for network MCP clients
  REST                    --rest — HTTP server with JSON endpoints under /api/* (no MCP)

Examples:
  adorable serve graph.db
  adorable serve graph.db --transport http --port 3001
  adorable serve graph.db --rest --port 3001
  adorable serve musiccardapp.db --project-root /path/to/musiccardapp
`);
}

function printChatHelp(): void {
  console.log(`
adorable chat <graph.db> — Interactive chat with an LLM using the graph as context.

Usage:
  adorable chat <graph.db> [options]

Options:
  --provider <name>       Shortcut for --llm <url> + API-key env-var lookup.
                          Recognized: openrouter, openai, anthropic, local.
                          Use --llm to override or to point at a custom
                          OpenAI-compatible endpoint.
  --llm <url>             LLM API URL (default: http://localhost:11434 for Ollama;
                          overrides --provider's URL when both are given).
  --model <name>          Model name (default: llama3 — provider-specific;
                          e.g. 'anthropic/claude-sonnet-4' for OpenRouter,
                          'gpt-4o' for OpenAI).
  --api-key <key>         API key for the LLM provider (see resolution order below)
  --project-root <path>   Project root for source file retrieval
  --project-config <path> Project config file (enables stitch rules)
  --help, -h              Show this help

API key resolution order:
  1. --api-key flag
  2. The provider-specific env var (when --provider is set):
       openrouter → OPENROUTER_API_KEY
       openai     → OPENAI_API_KEY
       anthropic  → ANTHROPIC_API_KEY
       local      → OLLAMA_API_KEY (usually not needed)
  3. OPENROUTER_API_KEY / OPENAI_API_KEY env var (backward-compat fallbacks)
  4. .env file in current directory
  5. .env file in --project-root directory

Examples:
  # Local Ollama, no API key needed:
  adorable chat graph.db --model llama3

  # OpenRouter — the fastest "try Adorable without installing an LLM client" path:
  adorable chat graph.db --provider openrouter --model anthropic/claude-sonnet-4
  # (with OPENROUTER_API_KEY set in env or .env)

  # OpenAI:
  adorable chat graph.db --provider openai --model gpt-4o

  # Custom endpoint (e.g. a self-hosted OpenAI-compatible proxy):
  adorable chat graph.db --llm https://llm.mycompany.com/v1 --model my-model
`);
}

function printProjectHelp(): void {
  console.log(`
adorable project — Manage multi-repo (monorepo) project configs.

Usage:
  adorable project init <path>            Initialize a config from a monorepo root
  adorable project analyze <config.json>  Analyze every repo in the config
  adorable project watch <config.json>    Re-analyze affected repos on file changes

Options (project analyze):
  --verbose, -v   Show per-file extraction progress
  --fresh         Delete the entire output database before starting
  --incremental   Re-extract only files that changed since the last
                  run (uses sha256 file hashes stored in the DB).
                  Mutually exclusive with --fresh; --fresh wins.
  --help, -h      Show this help

Options (project watch):
  --debounce <ms> Debounce window between observing a change and
                  re-analysing (default: 1000)
  --on-demand     Track changes without auto-firing. Press 'r' in
                  the terminal to refresh the dirty set, 'q' to quit.
                  Useful on large repos where re-analyze is costly.
  --incremental   Use --incremental analyze on each refresh cycle
                  (recommended for large repos). Composes with
                  --on-demand — recommended together on large repos.
  --verbose, -v   Print per-change file path under the affected repo

Examples:
  adorable project init /path/to/monorepo
  adorable project analyze myproject.project.json --verbose
  adorable project analyze myproject.project.json --verbose --fresh
  adorable project watch myproject.project.json --debounce 500
  adorable project watch myproject.project.json --incremental --on-demand
`);
}

function printInstallHelp(): void {
  console.log(`
adorable install <client> — Install Adorable as a skill in an LLM client.

Usage:
  adorable install <client> [--db <path>]
  adorable install --auto   [--db <path>]

Supported clients:
  claude-code   User-scoped. Writes SKILL.md to \$CLAUDE_CONFIG_DIR/skills/adorable/
                (or ~/.claude/skills/adorable/ by default). Idempotent.
                Does NOT register an MCP server — run
                  claude mcp add adorable -- adorable serve <project.db>
                separately once your project is analyzed.

  cursor        Project-scoped. Run from the project directory you want
                Cursor to use. Writes .cursor/rules/adorable.mdc always,
                and (when --db is provided) merges .cursor/mcp.json with
                an "adorable" MCP server entry pointing at the graph DB.
                Existing servers in mcp.json are preserved.

  continue      User-scoped. Merges $CONTINUE_GLOBAL_DIR/config.json (or
                ~/.continue/config.json by default) with a /adorable
                slash command + (when --db is provided) an "adorable"
                mcpServers entry. Other customCommands and mcpServers
                entries are preserved.

  vscode        Project-scoped. Run from the project directory you want
                VS Code + Copilot Chat to use. Upserts a delimited
                Adorable section in .github/copilot-instructions.md
                (existing instructions outside the markers are
                preserved verbatim), and (when --db is provided) merges
                .vscode/mcp.json with an "adorable" server entry.

  --auto        Detects each supported client by checking for its
                expected config directory (~/.claude, .cursor/ in
                cwd, ~/.continue, .vscode/ or .github/
                copilot-instructions.md in cwd) and installs into
                every one that's found. Clients without a detection
                signal are listed as "skipped" so you can install
                them manually with an explicit
                \`adorable install <client>\`.

Options:
  --db <path>   For 'cursor' and 'continue': the graph DB to wire into
                the MCP server entry. Path is resolved to absolute
                (cursor against the project directory, continue against
                the current working directory). Without --db, the skill
                installs but the MCP entry is deferred — re-run with
                --db once your project is analyzed.

The skill is the canonical "when to invoke Adorable" description that the
agent reads to know which question shapes belong to this tool.

Typical workflow:

  cd ~/my-project
  adorable project init .
  adorable project analyze my-project.project.json
  adorable install cursor --db my-project.db
  # restart Cursor

(More clients — ChatGPT custom GPT, --auto detection — land in follow-up slices.)
`);
}

function printToolsHelp(): void {
  console.log(`
adorable tools — List MCP tools available to LLMs and clients.

Usage:
  adorable tools [options]

Options:
  --help, -h   Show this help

Output groups every registered tool by category with its short description.
This is the same set the MCP server exposes via \`adorable serve\`, so it
matches what an LLM (Claude Code, etc.) sees when connected. No graph file
is required — the listing is static across analyzed projects.
`);
}

/**
 * MCP-tool categories as shown by `adorable tools`. Tools not listed here
 * are appended under "Other"; the categorization is matched by exact tool
 * name, so adding a new tool to the MCP server requires no CLI change
 * unless you want it grouped — otherwise it surfaces under "Other".
 */
const TOOL_CATEGORIES: Array<{ category: string; tools: string[] }> = [
  { category: 'Summary', tools: ['stats', 'describe_architecture', 'list_repositories'] },
  { category: 'Graph Query', tools: ['list_nodes', 'get_node', 'find_edges'] },
  { category: 'Flow', tools: ['walk_all_flows', 'walk_flows', 'walk_screen_flows', 'list_incomplete_flows'] },
  { category: 'Endpoints & Callers', tools: ['list_server_endpoints', 'list_client_api_calls', 'list_unmatched_callers', 'list_uncalled_endpoints', 'list_middleware'] },
  { category: 'Frontend / Mobile', tools: ['describe_screen', 'list_unreachable_screens', 'navigation_graph'] },
  { category: 'Files & Source', tools: ['describe_file', 'get_source_file', 'list_env_vars'] },
  { category: 'Stitching', tools: ['stitch', 'stitch_report', 'ai_stitch_review', 'suggest_stitches', 'add_stitch_rule', 'apply_stitch_rules', 'auto_stitch', 'confirm_stitch', 'reject_stitch'] },
  { category: 'Analysis', tools: ['impact_analysis', 'diff_flows'] },
];

interface ToolListing {
  totalTools: number;
  /** Tools that matched a TOOL_CATEGORIES entry, in declared order. */
  byCategory: Array<{ category: string; tools: Array<{ name: string; description: string }> }>;
  /** Tools the MCP server registers that aren't categorized. */
  uncategorized: Array<{ name: string; description: string }>;
}

/**
 * Enumerate every MCP tool the server registers, grouped by the
 * TOOL_CATEGORIES table. Exported for testing — the CLI command
 * `adorable tools` consumes this and prints it.
 *
 * @internal
 */
export async function listMcpToolsByCategory(): Promise<ToolListing> {
  const { SQLiteCanonicalGraphStore } = await import('@veoable/graph-db');
  const { createMcpServer } = await import('@veoable/mcp-server');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const store = new SQLiteCanonicalGraphStore(':memory:');
  try {
    const { server } = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'adorable-tools-cli', version: '0.1.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, { name: t.name, description: t.description ?? '' }]));

    const seen = new Set<string>();
    const byCategory: ToolListing['byCategory'] = [];
    for (const { category, tools: names } of TOOL_CATEGORIES) {
      const present = names
        .filter((n) => byName.has(n))
        .map((n) => byName.get(n)!);
      if (present.length === 0) continue;
      for (const t of present) seen.add(t.name);
      byCategory.push({ category, tools: present });
    }
    const uncategorized = [...byName.values()].filter((t) => !seen.has(t.name));

    await client.close();
    return { totalTools: tools.length, byCategory, uncategorized };
  } finally {
    store.close();
  }
}

/**
 * List every MCP tool the server registers, grouped by category. The tool
 * descriptions come from the live MCP-server registration so they stay in
 * sync with what an LLM client sees — no static description list to drift.
 */
async function printToolsList(): Promise<void> {
  const listing = await listMcpToolsByCategory();
  console.log(`\nAvailable MCP Tools (${listing.totalTools}):\n`);

  for (const { category, tools } of listing.byCategory) {
    console.log(`${category}:`);
    const padTo = Math.max(...tools.map((t) => t.name.length)) + 2;
    for (const t of tools) {
      console.log(`  ${t.name.padEnd(padTo)}${oneLine(t.description, 90 - padTo)}`);
    }
    console.log('');
  }

  if (listing.uncategorized.length > 0) {
    console.log('Other:');
    const padTo = Math.max(...listing.uncategorized.map((t) => t.name.length)) + 2;
    for (const t of listing.uncategorized) {
      console.log(`  ${t.name.padEnd(padTo)}${oneLine(t.description, 90 - padTo)}`);
    }
    console.log('');
  }

  console.log('Connect via `adorable serve <graph.db>` to expose these tools to an LLM client.');
}

/** Truncate to a single line at most maxLen characters, '…' suffixed if cut. */
function oneLine(s: string, maxLen: number): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, Math.max(0, maxLen - 1)) + '…';
}

// ──────────────────────────────────────────────────────────────────────
// Project init UX (#165) — config preview, edit guidance, prompts
// ──────────────────────────────────────────────────────────────────────

/**
 * Run `adorable project init` for `rootDir`: detect workspace packages
 * and write `<projectname>.project.json`. Returns the written filename
 * (relative to cwd). Throws on failure. Caller is responsible for
 * printing the guidance block via `printInitGuidance`.
 *
 * Path semantics: the file is written to `process.cwd()`, NOT to
 * `rootDir`. This matches `package.json`-style conventions and lets
 * users keep configs alongside other workspace artifacts even when
 * they invoke `init` against a different directory. The `Next step`
 * line in `printInitGuidance` is also cwd-relative for the same reason.
 *
 * @internal
 */
export async function runProjectInit(rootDir: string): Promise<string> {
  const { initProject } = await import('./project.js');
  const config = initProject(rootDir);
  const outputFile = `${config.name}.project.json`;
  fs.writeFileSync(outputFile, JSON.stringify(config, null, 2) + '\n');
  return outputFile;
}

/**
 * Print the guided post-`init` output: confirmation, full config JSON,
 * edit-guidance tips, and the next command (#165). Reads the freshly
 * written file rather than re-serializing the in-memory object so the
 * preview matches what's actually on disk.
 *
 * @internal
 */
export function printInitGuidance(outputFile: string): void {
  const contents = fs.readFileSync(outputFile, 'utf-8').trimEnd();
  console.log(
    `\n✓ Created ${outputFile}\n\n` +
    `${contents}\n\n` +
    `You can edit this file to:\n` +
    `  - Remove packages that don't need analysis (test fixtures, build tools,\n` +
    `    shared type packages with no endpoints or API callers)\n` +
    `  - Change repo names for clearer graph labels\n` +
    `  - Set "stitchMode": "auto-all" for aggressive stitching\n` +
    `  - Add stitchRules for URL prefix mapping (see tip below)\n\n` +
    `Tip — if your frontend calls /api/... but backend routes are /...,\n` +
    `add a stitchRule after the first analysis run:\n` +
    `    "stitchRules": [{\n` +
    `      "name": "Strip /api prefix",\n` +
    `      "from": "web", "to": "api",\n` +
    `      "transform": { "stripPrefix": "/api" }\n` +
    `    }]\n\n` +
    `Next step:\n` +
    `  adorable project analyze ${outputFile} --verbose --fresh`
  );
}

/**
 * Outcome of `handleMonorepoAnalyze`. The orchestrator (`main`) consumes
 * this and decides whether to continue with the whole-root analyze or
 * exit immediately after the user-guided init.
 *
 * @internal
 */
export type MonorepoAnalyzeAction =
  /** Not a monorepo — caller should proceed to the analyze step. */
  | { kind: 'not-monorepo' }
  /**
   * Monorepo with an existing project config. Caller printed a notice
   * and should continue with the whole-root analyze (matches the
   * pre-#165 behavior — preserves exit codes for users who explicitly
   * want it).
   */
  | { kind: 'continue-with-existing-config'; configPath: string }
  /**
   * Monorepo without a project config and stdin is not a TTY (CI /
   * piped input). Caller printed the warning and should continue.
   */
  | { kind: 'continue-non-interactive' }
  /**
   * Monorepo without a project config; stdin is a TTY; the user
   * declined to run init. Caller printed a warning and should continue.
   */
  | { kind: 'continue-after-decline' }
  /**
   * Monorepo without a project config; stdin is a TTY; the user
   * accepted the init prompt and runProjectInit completed. The
   * outputFile is the freshly written config. Caller should exit 0
   * after `printInitGuidance(outputFile)`.
   */
  | { kind: 'init-and-exit'; outputFile: string };

/**
 * Decide what to do when `adorable analyze` is invoked against a
 * potential monorepo root (#165). Returns one of the
 * {@link MonorepoAnalyzeAction} variants. May prompt the user when
 * stdin is a TTY and no project config already exists.
 *
 * Side effects: prints the warning / notice to stderr, prompts the
 * user (TTY only), and (for the accept-prompt branch) writes the
 * project config via `runProjectInit`. Does NOT print
 * `printInitGuidance` or call `process.exit` — that's the orchestrator's
 * job, so this helper stays exit-free for unit testing.
 *
 * @internal
 */
export async function handleMonorepoAnalyze(
  rootDir: string,
  opts: {
    /** Override the TTY detection — used by tests. Defaults to `process.stdin.isTTY`. */
    isTTY?: boolean;
    /** Override the prompt — used by tests. Defaults to `promptYesNo`. */
    prompt?: (question: string, defaultYes: boolean) => Promise<boolean>;
  } = {},
): Promise<MonorepoAnalyzeAction> {
  if (!detectMonorepo(rootDir)) return { kind: 'not-monorepo' };

  const projectName = path.basename(rootDir);
  const candidateConfig = `${projectName}.project.json`;
  const inCwd = fs.existsSync(candidateConfig);
  const inRoot = fs.existsSync(path.join(rootDir, candidateConfig));
  const configExists = inCwd || inRoot;

  if (configExists) {
    const configPath = inCwd ? candidateConfig : path.join(rootDir, candidateConfig);
    console.error(
      `Note: ${projectName} appears to be a monorepo and a project config already exists.\n` +
      `  To analyze using the config:\n` +
      `    adorable project analyze ${configPath} --verbose --fresh\n` +
      `  Continuing with whole-root analyze (may OOM)…\n`
    );
    return { kind: 'continue-with-existing-config', configPath };
  }

  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    console.error(
      `Note: ${projectName} appears to be a monorepo (has workspace config).\n` +
      `  Analyzing the entire root may cause out-of-memory errors.\n` +
      `  Consider: adorable project init ${rootDir}\n` +
      `  Then:     adorable project analyze ${candidateConfig} --verbose\n`
    );
    return { kind: 'continue-non-interactive' };
  }

  const prompt = opts.prompt ?? promptYesNo;
  const accept = await prompt(
    `\nNote: ${projectName} appears to be a monorepo. Run \`adorable project init\` first to analyze each package separately?`,
    true,
  );
  if (accept) {
    const outputFile = await runProjectInit(rootDir);
    return { kind: 'init-and-exit', outputFile };
  }
  console.error(`Continuing with whole-root analyze (may OOM)…\n`);
  return { kind: 'continue-after-decline' };
}

/**
 * Detect whether `rootDir` is a monorepo via pnpm-workspace.yaml or
 * package.json `workspaces`. Returns false on any read failure.
 */
function detectMonorepo(rootDir: string): boolean {
  if (fs.existsSync(path.join(rootDir, 'pnpm-workspace.yaml'))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    return Array.isArray(pkg.workspaces) || !!pkg.workspaces?.packages;
  } catch {
    return false;
  }
}

/**
 * Prompt the user with a yes/no question. Returns the default answer
 * (without prompting) when stdin is not a TTY — keeps CI / piped-input
 * scripts working with the prior exit-code behavior. Also returns the
 * default if stdin is closed mid-prompt (Ctrl-D / EOF) so the caller
 * doesn't see an unhandled rejection.
 *
 * @internal
 */
export async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer.startsWith('y');
  } catch {
    // EOF / stdin closed / readline aborted — fall back to the default.
    // The prompt was a yes/no question; either answer is recoverable.
    return defaultYes;
  } finally {
    rl.close();
  }
}

/**
 * Route --help to the right command-specific block, or fall back to the
 * overview. Exported as @internal so the test suite can assert dispatch
 * without spawning a subprocess.
 *
 * @internal
 */
export function printHelp(command: string): void {
  switch (command) {
    case 'analyze': return printAnalyzeHelp();
    case 'serve': return printServeHelp();
    case 'chat': return printChatHelp();
    case 'project': return printProjectHelp();
    case 'tools': return printToolsHelp();
    case 'install': return printInstallHelp();
    default: return printOverview();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // `--help` (with or without a command) → help, exit 0. Top-level
  // `--help` shows the overview; `<cmd> --help` shows that command's
  // detailed help.
  if (args.help) {
    printHelp(args.command);
    process.exit(0);
  }

  // No command and no --help → usage error, print overview and exit 1.
  if (args.command === '') {
    printOverview();
    process.exit(1);
  }

  if (args.command === 'tools') {
    try {
      await printToolsList();
    } catch (err) {
      console.error(`Error listing tools: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  if (args.command === 'install') {
    // `adorable install <client>` — drop the Adorable skill into the
    // named LLM client's expected location. claude-code + continue are
    // user-scoped (~/.claude/skills/, ~/.continue/config.json); cursor
    // is project-scoped (./.cursor/) so it honors cwd. `--auto` walks
    // every supported client, installs into the ones that are
    // detected, and lists the rest as skipped.
    const SUPPORTED_INSTALL_CLIENTS = ['claude-code', 'cursor', 'continue', 'vscode'] as const;
    type SupportedInstallClient = typeof SUPPORTED_INSTALL_CLIENTS[number];
    const supportedList = `Supported clients: ${SUPPORTED_INSTALL_CLIENTS.join(', ')}`;

    if (args.auto) {
      try {
        const { installAuto } = await import('./install.js');
        const { installed, skipped, failed } = installAuto({ db: args.db || undefined });
        if (installed.length === 0 && failed.length === 0) {
          console.error('✗ No supported LLM clients detected.');
          for (const s of skipped) console.error(`  · ${s.client}: ${s.reason}`);
          process.exit(1);
        }
        for (const result of installed) {
          console.error(`✓ Installed skill '${result.client}'.`);
          console.error('  Wrote:');
          for (const f of result.filesWritten) console.error(`    ${f}`);
        }
        if (failed.length > 0) {
          console.error('');
          console.error('Failed:');
          for (const f of failed) console.error(`  ✗ ${f.client}: ${f.error}`);
        }
        if (skipped.length > 0) {
          console.error('');
          console.error('Skipped (no detection signal):');
          for (const s of skipped) console.error(`  · ${s.client}: ${s.reason}`);
        }
        if (installed.length > 0) {
          console.error('');
          console.error('Next steps:');
          for (const result of installed) {
            console.error(`  [${result.client}]`);
            for (const line of result.nextSteps) console.error(`    ${line}`);
          }
        }
        // Exit 1 if anything failed so CI can react. Partial success
        // is still surfaced above so a human reading the output sees
        // exactly which clients made it through.
        if (failed.length > 0) process.exit(1);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }

    const client = args.projectPath; // reuse positional
    if (client === '.' || client === '') {
      console.error('Usage: adorable install <client> [--db <path>]');
      console.error('       adorable install --auto [--db <path>]');
      console.error(supportedList);
      process.exit(1);
    }
    if (!SUPPORTED_INSTALL_CLIENTS.includes(client as SupportedInstallClient)) {
      console.error(`Unsupported client: ${client}`);
      console.error(supportedList);
      console.error('(More clients land in follow-up slices of #363.)');
      process.exit(1);
    }
    try {
      const {
        installClaudeCodeSkill,
        installCursorSkill,
        installContinueSkill,
        installVSCodeSkill,
      } = await import('./install.js');
      const result = client === 'claude-code'
        ? installClaudeCodeSkill()
        : client === 'cursor'
          ? installCursorSkill({ db: args.db || undefined })
          : client === 'continue'
            ? installContinueSkill({ db: args.db || undefined })
            : installVSCodeSkill({ db: args.db || undefined });
      console.error(`✓ Installed skill '${result.client}'.`);
      console.error('Wrote:');
      for (const f of result.filesWritten) console.error(`  ${f}`);
      console.error('');
      console.error('Next steps:');
      for (const line of result.nextSteps) console.error(line);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  if (args.command === 'serve') {
    const dbPath = args.projectPath; // reuse the positional arg
    if (dbPath === '.') {
      console.error('Usage: adorable serve <graph.db> [--project-root <path>]');
      process.exit(1);
    }
    try {
      const { SQLiteCanonicalGraphStore } = await import('@veoable/graph-db');
      const resolvedDbPath = path.resolve(dbPath);
      const projectRoot = args.projectRoot
        ? path.resolve(args.projectRoot)
        : path.dirname(resolvedDbPath);
      const store = new SQLiteCanonicalGraphStore(resolvedDbPath);

      if (args.rest) {
        // REST API mode — HTTP server with JSON endpoints.
        const { createRestServer } = await import('@veoable/mcp-server');
        const pcPath = args.projectConfig ? path.resolve(args.projectConfig) : undefined;
        const rest = createRestServer(store, { projectRoot, port: args.port, projectConfigPath: pcPath, dbPath: resolvedDbPath });
        await rest.start();
        console.error(`Adorable REST API server listening on http://localhost:${args.port}`);
        console.error(`  Tools: http://localhost:${args.port}/api/tools`);
        console.error(`  Graph: ${dbPath}, projectRoot: ${projectRoot}`);
      } else if (args.transport === 'http') {
        // HTTP MCP mode — StreamableHTTP transport for network MCP clients.
        // Single transport instance shared across all requests.
        const { createMcpServer } = await import('@veoable/mcp-server');
        const { StreamableHTTPServerTransport } = await import(
          '@modelcontextprotocol/sdk/server/streamableHttp.js'
        );
        const http = await import('node:http');
        const { server: mcpServer } = createMcpServer(store, { projectRoot, projectConfigPath: args.projectConfig ? path.resolve(args.projectConfig) : undefined, dbPath: resolvedDbPath });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcpServer.connect(transport);

        const httpServer = http.createServer(async (req, res) => {
          if (req.url === '/mcp') {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', async () => {
              try {
                const body = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
                await transport.handleRequest(req, res, body);
              } catch (err) {
                res.writeHead(400);
                res.end('Invalid request');
              }
            });
            return;
          }
          res.writeHead(404);
          res.end('Not found');
        });

        httpServer.listen(args.port, () => {
          console.error(`Adorable HTTP MCP server listening on http://localhost:${args.port}/mcp`);
          console.error(`  Graph: ${dbPath}, projectRoot: ${projectRoot}`);
        });
      } else {
        // stdio MCP mode — for Claude Code, Cursor, Windsurf, etc.
        const { createMcpServer } = await import('@veoable/mcp-server');
        const { StdioServerTransport } = await import(
          '@modelcontextprotocol/sdk/server/stdio.js'
        );
        const { server } = createMcpServer(store, { projectRoot, projectConfigPath: args.projectConfig ? path.resolve(args.projectConfig) : undefined, dbPath: resolvedDbPath });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error(`Adorable MCP server connected (graph: ${dbPath}, projectRoot: ${projectRoot})`);
      }
    } catch (err) {
      console.error(`Error starting server:`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (args.command === 'chat') {
    const dbPath = args.projectPath;
    if (dbPath === '.') {
      console.error('Usage: adorable chat <graph.db> [--provider <name> | --llm <url>] [--model <name>]');
      process.exit(1);
    }
    try {
      const { SQLiteCanonicalGraphStore } = await import('@veoable/graph-db');
      const { runChat } = await import('./chat.js');
      const { resolveProvider } = await import('./providers.js');
      const resolvedDbPath = path.resolve(dbPath);
      const projectRoot = args.projectRoot
        ? path.resolve(args.projectRoot)
        : path.dirname(resolvedDbPath);

      // Load .env file for API keys (#172).
      // Search order: current directory, --project-root, db file directory.
      loadDotenv(process.cwd());
      loadDotenv(projectRoot);

      // --provider is a shortcut for --llm <known-url>. Explicit --llm
      // always wins so a user can still point at a custom OpenAI-
      // compatible endpoint while using --provider for the API-key
      // fallback. Throws on an unknown provider name.
      const provider = resolveProvider(args.provider);
      const llmUrl = args.llm !== 'http://localhost:11434'
        ? args.llm
        : (provider?.llmUrl ?? args.llm);
      // API-key precedence: explicit flag, then the provider's own
      // env var (when --provider is set), then the historical
      // OPENROUTER_API_KEY / OPENAI_API_KEY fallbacks for users who
      // were on the pre-`--provider` flow.
      const fallbacks: string[] = [];
      if (provider?.apiKeyEnvVar) fallbacks.push(provider.apiKeyEnvVar);
      for (const v of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
        if (!fallbacks.includes(v)) fallbacks.push(v);
      }
      const apiKey = args.apiKey
        || fallbacks.map((v) => process.env[v]).find((v) => v && v.length > 0)
        || '';

      const store = new SQLiteCanonicalGraphStore(resolvedDbPath);
      await runChat(store, {
        llmUrl,
        model: args.model,
        apiKey,
        serverOpts: {
          projectRoot,
          dbPath: resolvedDbPath,
          projectConfigPath: args.projectConfig ? path.resolve(args.projectConfig) : undefined,
        },
      });
      store.close();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  if (args.command === 'project') {
    const subcommand = args.projectPath; // reuse positional
    const thirdArg = process.argv[process.argv.indexOf('project') + 2];

    if (subcommand === 'init') {
      // `adorable project init /path/to/monorepo`
      const rootDir = thirdArg ?? '.';
      try {
        const outputFile = await runProjectInit(rootDir);
        printInitGuidance(outputFile);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }

    if (subcommand === 'analyze') {
      // `adorable project analyze config.json`
      if (!thirdArg) {
        console.error('Usage: adorable project analyze <config.json> [--verbose] [--fresh]');
        process.exit(1);
      }
      try {
        const { analyzeProject } = await import('./project.js');
        await analyzeProject(thirdArg, {
          verbose: args.verbose,
          fresh: args.fresh,
          incremental: args.incremental,
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }

    if (subcommand === 'watch') {
      // `adorable project watch config.json [--debounce N] [--on-demand] [--incremental]`
      if (!thirdArg) {
        console.error(
          'Usage: adorable project watch <config.json> [--debounce <ms>] [--on-demand] [--incremental] [--verbose]',
        );
        process.exit(1);
      }
      // Parse extra flags out of process.argv (the global parser
      // doesn't know about them).
      let debounceMs = 1000;
      const dbIdx = process.argv.indexOf('--debounce');
      if (dbIdx >= 0 && process.argv[dbIdx + 1]) {
        const n = Number.parseInt(process.argv[dbIdx + 1]!, 10);
        if (Number.isFinite(n) && n > 0) debounceMs = n;
      }
      const onDemand = process.argv.includes('--on-demand');
      try {
        const { watchProject } = await import('./watch.js');
        const handle = await watchProject(thirdArg, {
          verbose: args.verbose,
          debounceMs,
          onDemand,
          incremental: args.incremental,
        });

        // Stay alive until SIGINT / SIGTERM / 'q'. Single shutdown
        // path guarded by `isShuttingDown` because in raw-mode stdin
        // Ctrl-C arrives BOTH as the '\x03' data byte AND as a SIGINT
        // signal -- without the guard both handlers race, calling
        // handle.stop() + process.exit(0) twice and double-closing
        // the watcher.
        let isShuttingDown = false;
        const shutdown = async () => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          if (onDemand && process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch { /* ignore */ }
            process.stdin.pause();
          }
          await handle.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // On-demand mode: register an 'r' / 'q' keypress UI on stdin
        // when running attached to a TTY. Other modes leave stdin
        // alone so chokidar/process behave normally. Ctrl-C in raw
        // mode is routed through SIGINT (Node still emits it), so
        // the keypress branch deliberately does NOT handle '\x03'.
        if (onDemand && process.stdin.isTTY) {
          const { stdin } = process;
          stdin.setRawMode(true);
          stdin.resume();
          stdin.setEncoding('utf8');
          console.error("Press 'r' to refresh, 'q' or Ctrl-C to quit.");
          stdin.on('data', (key: string) => {
            if (key === 'r' || key === 'R') {
              const dirty = handle.dirtyRepos();
              if (dirty.length === 0) {
                console.error('  (no dirty repos — nothing to refresh)');
                return;
              }
              console.error(`  triggered refresh for: ${dirty.join(', ')}`);
              void handle.refreshNow();
            } else if (key === 'q' || key === 'Q') {
              void shutdown();
            }
            // '\x03' (Ctrl-C) intentionally falls through to SIGINT.
          });
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }

    console.error('Usage: adorable project <init|analyze|watch> ...');
    process.exit(1);
  }

  if (args.command !== 'analyze') {
    console.error(`Unknown command: ${args.command}`);
    console.error('Run "adorable --help" for usage.');
    process.exit(1);
  }

  const rootDir = path.resolve(args.projectPath);

  // Decide what to do when running against a monorepo root (#165).
  // The helper handles all branching (existing config, TTY prompt,
  // non-TTY warning) and returns an action; we just exit or continue.
  const action = await handleMonorepoAnalyze(rootDir);
  if (action.kind === 'init-and-exit') {
    printInitGuidance(action.outputFile);
    process.exit(0);
  }

  // --fresh: delete the database and its WAL/SHM companion files.
  if (args.fresh && args.output !== ':memory:') {
    const fs = await import('node:fs');
    const resolved = path.resolve(args.output);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(resolved + suffix); } catch { /* ignore if not exists */ }
    }
    if (args.verbose) {
      console.error(`Deleted ${args.output} (fresh start)`);
    }
    // --fresh wins over --incremental (matches the help text and the
    // project-analyze short-circuit). With no DB on disk the hash diff
    // is a no-op anyway, but clearing the flag also stops the analyze
    // log line claiming "incremental" on a cold start.
    args.incremental = false;
  }

  try {
    const result = await analyze({
      rootDir,
      dbPath: args.output,
      exclude: args.exclude,
      maxCallDepth: args.maxCallDepth,
      stitchMode: args.stitchMode,
      repoName: args.repoName || undefined,
      clean: args.clean,
      incremental: args.incremental,
      mergeTracePaths: args.mergeTrace.length > 0 ? args.mergeTrace : undefined,
      onProgress: args.verbose ? (msg) => console.error(msg) : undefined,
    });

    const output = args.format === 'json' ? formatJson(result) : formatText(result);
    console.log(output);

    if (args.output !== ':memory:') {
      console.error(`\nGraph saved to ${args.output}`);
    }

    result.store.close();
  } catch (err) {
    console.error(`Error analyzing ${rootDir}:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Only run when executed directly, not when imported for testing.
// In a bundled ESM context, check if this module is the entry point.
/**
 * Load environment variables from a .env file if it exists (#172).
 * Only sets variables that are not already defined in the environment
 * (existing env vars take precedence over .env values).
 */
function loadDotenv(dir: string): void {
  const envPath = path.join(dir, '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return; // File doesn't exist — silently skip
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Don't override existing environment variables
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('/cli.js') || process.argv[1].endsWith('/cli.ts'));
if (isDirectRun) {
  main();
}
