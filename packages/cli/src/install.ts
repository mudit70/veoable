import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSkillDescription, getSkillMarkdown, SKILL_NAME } from '@veoable/skill';

/**
 * #363 — install the Adorable skill into supported LLM clients.
 *
 * The skill is the canonical "when to invoke Adorable" description
 * (packages/skill/SKILL.md). Each client has its own expected location
 * for skill files; this module writes the right files for the named
 * client and prints next-step instructions.
 *
 * Supported today: `claude-code` (user-scoped, ~/.claude/skills/),
 * `cursor` (project-scoped, .cursor/), `continue` (user-scoped,
 * ~/.continue/config.json), and `vscode` (project-scoped, .vscode/ +
 * .github/copilot-instructions.md). ChatGPT custom GPT lands in a
 * follow-up slice once mcp-server's tool metadata is extractable
 * without a store (for OpenAPI Action schema generation).
 */

/**
 * Strip SKILL.md's YAML frontmatter and return only the body. Used by
 * adapters whose target format (e.g. Cursor .mdc) prepends its own
 * frontmatter and would conflict with ours.
 */
function getSkillBody(): string {
  const md = getSkillMarkdown();
  const stripped = md.replace(/^---\n[\s\S]*?\n---\n+/, '');
  return stripped;
}

/**
 * Result of installing a skill — used by tests + the CLI's printed
 * summary. The CLI prints `nextSteps` to stderr after install completes.
 */
export interface InstallResult {
  client: string;
  filesWritten: string[];
  nextSteps: string[];
}

export interface InstallClaudeCodeOptions {
  /**
   * Target skills directory. Defaults to:
   *   $CLAUDE_CONFIG_DIR/skills/veoable
   *   ~/.claude/skills/veoable
   * In that order. Pass an explicit value from tests to avoid touching
   * the user's real Claude Code config.
   */
  dir?: string;
  /**
   * Where to look up $CLAUDE_CONFIG_DIR / $HOME when `dir` isn't given.
   * Defaults to `process.env`. Exposed for tests.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the Claude Code skills directory for Adorable.
 *
 * Priority:
 *   1. Explicit `dir` argument (test/CI use).
 *   2. `$CLAUDE_CONFIG_DIR/skills/veoable` (Claude Code honors this
 *      env var when discovering skills).
 *   3. `~/.claude/skills/veoable` (the default Claude Code path).
 */
function resolveSkillDir(opts: InstallClaudeCodeOptions): string {
  if (opts.dir) return opts.dir;
  const env = opts.env ?? process.env;
  if (env.CLAUDE_CONFIG_DIR) {
    return path.join(env.CLAUDE_CONFIG_DIR, 'skills', SKILL_NAME);
  }
  const home = env.HOME ?? os.homedir();
  return path.join(home, '.claude', 'skills', SKILL_NAME);
}

/**
 * Install the Adorable skill into Claude Code by writing SKILL.md
 * into the expected skills directory. Idempotent — re-running
 * overwrites with the current canonical content.
 *
 * Does NOT touch ~/.claude.json or register an MCP server. That's
 * a separate concern (the user usually doesn't have a graph DB at
 * install time), and editing a config we don't own the schema of
 * risks corruption. The printed nextSteps explain the
 * `claude mcp add` call the user should make once they've analyzed
 * their project.
 */
export function installClaudeCodeSkill(opts: InstallClaudeCodeOptions = {}): InstallResult {
  const skillDir = resolveSkillDir(opts);
  fs.mkdirSync(skillDir, { recursive: true });

  const skillFile = path.join(skillDir, 'SKILL.md');
  const markdown = getSkillMarkdown();
  fs.writeFileSync(skillFile, markdown, 'utf-8');

  return {
    client: 'claude-code',
    filesWritten: [skillFile],
    nextSteps: [
      'Build a graph for your project (if you haven\'t already):',
      '  veoable project init <path>',
      '  veoable project analyze <project.json>',
      '',
      'Register the MCP server with Claude Code so the skill has data to query:',
      '  claude mcp add veoable -- veoable serve <project.db>',
      '',
      'For live updates during a session, leave a watcher running:',
      '  veoable project watch <project.json> --incremental --on-demand',
      "  (press 'r' before asking Claude a question that needs fresh data)",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Cursor adapter
// ─────────────────────────────────────────────────────────────────────

export interface InstallCursorOptions {
  /**
   * Project directory. Cursor reads rules + MCP config from
   * `<projectDir>/.cursor/`. Defaults to the current working directory.
   * Tests pass a temp dir to avoid touching the user's real project.
   */
  projectDir?: string;
  /**
   * Absolute path to the graph DB. When provided, .cursor/mcp.json is
   * merged with an `veoable` entry pointing here. When omitted, the
   * rule still installs but the user must run `veoable install cursor
   * --db <path>` (or edit .cursor/mcp.json by hand) to wire up the
   * MCP server.
   */
  db?: string;
}

/**
 * Build Cursor's .mdc rule body. Cursor expects its own YAML
 * frontmatter (`description`, `alwaysApply`) rather than SKILL.md's
 * native (`name`, `description`). We feed Cursor the same description
 * (parsed from SKILL.md so the source of truth stays one file) and
 * embed the SKILL.md body without our frontmatter.
 */
function buildCursorRule(): string {
  const description = getSkillDescription();
  const body = getSkillBody();
  // alwaysApply: false → Cursor activates the rule via
  // description-matching, not on every prompt. Matches the
  // trigger-shape routing SKILL.md was authored for.
  return `---\ndescription: ${description}\nalwaysApply: false\n---\n\n${body}`;
}

/**
 * Read .cursor/mcp.json if it exists; return an empty object on miss
 * or on parse failure (we'd rather rewrite a stale file than throw
 * — the user can always recover the old version from git).
 */
function readCursorMcpJson(jsonPath: string): { mcpServers?: Record<string, unknown> } {
  if (!fs.existsSync(jsonPath)) return {};
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed;
  } catch {
    // Malformed JSON — we overwrite. The caller has git for recovery.
    return {};
  }
}

/**
 * Install the Adorable skill into a Cursor project.
 *
 * Writes:
 *   - `<projectDir>/.cursor/rules/veoable.mdc` — always.
 *   - `<projectDir>/.cursor/mcp.json` — only when `db` is provided.
 *     Merges with existing `mcpServers` to preserve any other servers
 *     the user has configured.
 *
 * Idempotent: re-running with the same args replaces the rule file
 * and rewrites the mcp.json entry; other entries are preserved.
 */
export function installCursorSkill(opts: InstallCursorOptions = {}): InstallResult {
  const projectDir = opts.projectDir ?? process.cwd();
  const cursorDir = path.join(projectDir, '.cursor');
  const rulesDir = path.join(cursorDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const ruleFile = path.join(rulesDir, `${SKILL_NAME}.mdc`);
  fs.writeFileSync(ruleFile, buildCursorRule(), 'utf-8');

  const filesWritten = [ruleFile];
  const nextSteps: string[] = [];

  if (opts.db) {
    // Resolve --db relative to projectDir, not cwd. Absolute paths
    // pass through unchanged (path.resolve ignores earlier args once
    // it hits an absolute segment). Without this, a user running
    // `veoable install cursor --db p.db` from a parent directory
    // would silently bake the wrong path into mcp.json.
    const dbAbs = path.resolve(projectDir, opts.db);
    const mcpFile = path.join(cursorDir, 'mcp.json');
    const existing = readCursorMcpJson(mcpFile);
    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    servers[SKILL_NAME] = {
      command: 'veoable',
      args: ['serve', dbAbs],
    };
    const merged = { ...existing, mcpServers: servers };
    fs.writeFileSync(mcpFile, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    filesWritten.push(mcpFile);

    nextSteps.push(
      'Restart Cursor (or reload the window) so it picks up the new rule and MCP server.',
      '',
      'For live updates during a session, leave a watcher running:',
      '  veoable project watch <project.json> --incremental --on-demand',
      "  (press 'r' before asking Cursor a question that needs fresh data)",
    );
  } else {
    nextSteps.push(
      'Build a graph for your project (if you haven\'t already):',
      '  veoable project init <path>',
      '  veoable project analyze <project.json>',
      '',
      'Re-run this command with --db to wire the MCP server entry:',
      '  veoable install cursor --db <project.db>',
      '',
      'Restart Cursor (or reload the window) once both files are in place.',
    );
  }

  return {
    client: 'cursor',
    filesWritten,
    nextSteps,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Continue.dev adapter
// ─────────────────────────────────────────────────────────────────────

export interface InstallContinueOptions {
  /**
   * Continue's global config directory. Continue reads `config.json`
   * from this path. Defaults to:
   *   $CONTINUE_GLOBAL_DIR
   *   ~/.continue
   * Tests pass an explicit value to avoid touching the real config.
   */
  continueDir?: string;
  /** Absolute or projectDir-relative path to the graph DB. */
  db?: string;
  /** Env lookup for $CONTINUE_GLOBAL_DIR / $HOME. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

function resolveContinueDir(opts: InstallContinueOptions): string {
  if (opts.continueDir) return opts.continueDir;
  const env = opts.env ?? process.env;
  if (env.CONTINUE_GLOBAL_DIR) return env.CONTINUE_GLOBAL_DIR;
  const home = env.HOME ?? os.homedir();
  return path.join(home, '.continue');
}

/**
 * Continue's config.json shape we touch:
 *
 *   {
 *     "customCommands": [{ name, prompt, description }, ...],
 *     "mcpServers": { <name>: { command, args }, ... },
 *     ... (other top-level keys preserved verbatim)
 *   }
 *
 * Custom commands surface as `/veoable` slash commands; the prompt
 * is the SKILL.md body so the agent has the full routing layer in
 * context whenever the user invokes it.
 *
 * TODO(#363): Continue is migrating to ~/.continue/config.yaml with
 * `prompts:` blocks in place of `customCommands`. The legacy
 * config.json + customCommands shape is documented as deprecated but
 * still supported. A follow-up slice should detect which config style
 * the user is on and write the appropriate file (yaml + `prompts` for
 * new installs, json + `customCommands` for upgrades-in-place).
 */
interface ContinueCustomCommand {
  name: string;
  prompt: string;
  description?: string;
}

interface ContinueConfig {
  customCommands?: ContinueCustomCommand[];
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

function readContinueConfig(jsonPath: string): ContinueConfig {
  if (!fs.existsSync(jsonPath)) return {};
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as ContinueConfig;
  } catch {
    // Malformed — overwrite. User has git for recovery.
    return {};
  }
}

/**
 * Install the Adorable skill into Continue.dev's global config.
 *
 * Writes a single file: `<continueDir>/config.json`. Merges in:
 *   - `customCommands[veoable]` with the SKILL.md body as the prompt
 *     and the SKILL.md frontmatter description as the help text.
 *   - `mcpServers.veoable` pointing at the graph DB (when `db` given).
 *
 * Other entries in `customCommands` and `mcpServers` are preserved.
 * Other top-level keys in config.json are preserved verbatim. The
 * write rewrites the whole file with 2-space JSON indent + trailing
 * newline.
 */
export function installContinueSkill(opts: InstallContinueOptions = {}): InstallResult {
  const continueDir = resolveContinueDir(opts);
  fs.mkdirSync(continueDir, { recursive: true });
  const configFile = path.join(continueDir, 'config.json');

  const existing = readContinueConfig(configFile);

  // Custom command — always installed. Continue surfaces this as
  // `/veoable` in the chat input. The prompt is the full SKILL.md
  // body so when the user invokes the command, the agent gets the
  // routing layer + recipes in one shot.
  const adorableCommand: ContinueCustomCommand = {
    name: SKILL_NAME,
    description: getSkillDescription(),
    prompt: getSkillBody(),
  };

  const customCommands = Array.isArray(existing.customCommands)
    ? existing.customCommands.filter((c) => c && c.name !== SKILL_NAME)
    : [];
  customCommands.push(adorableCommand);

  // MCP server entry — opt-in via --db. Other entries preserved.
  const mcpServers: Record<string, unknown> = { ...(existing.mcpServers ?? {}) };
  const nextSteps: string[] = [];

  if (opts.db) {
    // Continue is user-scoped (no projectDir concept), so --db
    // resolves against the current working directory. Users running
    // from somewhere other than their project root should pass an
    // absolute path. Cursor's adapter resolves against projectDir
    // because Cursor configs are project-scoped — different concern.
    const dbAbs = path.resolve(opts.db);
    mcpServers[SKILL_NAME] = {
      command: 'veoable',
      args: ['serve', dbAbs],
    };
    nextSteps.push(
      'Restart Continue (or reload your editor) so it picks up the new slash command and MCP server.',
      '',
      'In a Continue chat, type:  /veoable',
      'to invoke the skill explicitly. Continue also routes free-form questions',
      'to the MCP server when the description matches.',
      '',
      'For live updates during a session, leave a watcher running:',
      '  veoable project watch <project.json> --incremental --on-demand',
      "  (press 'r' before asking Continue a question that needs fresh data)",
    );
  } else {
    nextSteps.push(
      'Build a graph for your project (if you haven\'t already):',
      '  veoable project init <path>',
      '  veoable project analyze <project.json>',
      '',
      'Re-run this command with --db to wire the MCP server entry:',
      '  veoable install continue --db <project.db>',
      '',
      'Without an MCP server, the /veoable slash command can still surface',
      'the skill description and recipes, but tools won\'t be callable.',
    );
  }

  const merged: ContinueConfig = {
    ...existing,
    customCommands,
    mcpServers,
  };

  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

  return {
    client: 'continue',
    filesWritten: [configFile],
    nextSteps,
  };
}

// ─────────────────────────────────────────────────────────────────────
// VS Code (Copilot Chat) adapter
// ─────────────────────────────────────────────────────────────────────

export interface InstallVSCodeOptions {
  /**
   * Project directory. VS Code reads workspace MCP config from
   * `<projectDir>/.vscode/mcp.json` and per-repo Copilot instructions
   * from `<projectDir>/.github/copilot-instructions.md`. Defaults to
   * cwd.
   */
  projectDir?: string;
  /**
   * Absolute or projectDir-relative path to the graph DB. When given,
   * `.vscode/mcp.json` is merged with an `veoable` server entry. When
   * omitted, only the Copilot instructions section is written and the
   * user must re-run with --db to wire up the MCP server.
   */
  db?: string;
}

// Marker pair for the Adorable section in .github/copilot-instructions.md.
// The start marker carries a `v=` version tag so a future format change can
// recognize old sections and migrate them. New installs always write the
// CURRENT form (`COPILOT_START_MARKER`); on upsert, ANY known historical
// form (listed in `COPILOT_START_MARKERS`) matches the existing section and
// gets replaced with the current form. This keeps migrations clean.
const COPILOT_START_MARKER = '<!-- veoable:start v=1 (managed by `veoable install vscode`) -->';
const COPILOT_START_MARKERS: readonly string[] = [
  COPILOT_START_MARKER,
];
const COPILOT_END_MARKER = '<!-- veoable:end -->';

/**
 * Build the Copilot instructions section. Deliberately SHORT (~400
 * tokens) because `.github/copilot-instructions.md` is injected into
 * every Copilot Chat request — burning 9 KB of SKILL.md there would
 * eat the user's context budget on every interaction. The agent gets
 * the full SKILL.md mid-session via the `describe_skill` MCP tool.
 */
function buildCopilotInstructionsSection(): string {
  return [
    COPILOT_START_MARKER,
    '## Adorable — End-to-End Flow Analysis',
    '',
    "This repository is wired up with Adorable, a tool that builds a queryable",
    'graph of every API endpoint, client caller, screen, DB table, and the flows',
    'between them. The MCP server `veoable` is registered in `.vscode/mcp.json`.',
    '',
    '**Use Adorable tools FIRST for these question shapes:**',
    '',
    "- Architecture / overview — \"what does this app do?\", \"what endpoints does X expose?\"",
    "- Behavior tracing — \"what happens when user does X?\", \"trace the login flow\"",
    "- Blast radius / refactoring — \"what breaks if I change this endpoint/table?\", \"review this PR\"",
    "- Inventory / dead-code hunting — \"which endpoints are dead?\", \"where is env.X used?\"",
    "- Debugging stuck flows — \"why isn't this client call resolving?\"",
    '',
    '**Do NOT invoke Adorable for:**',
    '',
    '- Single-file syntax, style, or typing questions — use the editor itself.',
    '- Build, CI, or deployment questions — Adorable analyzes source, not pipelines.',
    "- Runtime / \"what's running right now\" questions — it's a static graph, not a tracer.",
    '- Library-internal questions — Adorable only sees user code.',
    '',
    '**How to use the tools well:**',
    '',
    '1. Call `describe_skill` once at session start for the full routing layer + tool catalog + recipes.',
    '2. Start broad: `list_repositories`, `describe_architecture`, then narrow.',
    '3. Prefer aggregated tools (`list_server_endpoints`, `list_screens`) over chaining graph primitives.',
    '4. Cite `sourceFile`/`sourceLine` from every node so the user can jump there.',
    '',
    "If the graph DB hasn't been built yet, tell the user to run `veoable project init` + `veoable project analyze`.",
    COPILOT_END_MARKER,
  ].join('\n');
}

/**
 * Insert (or replace) the Adorable section in a Copilot instructions
 * file. Three cases:
 *
 *   1. File doesn't exist → create with just the Adorable section.
 *   2. File exists with our markers → replace the delimited region.
 *      Preserves everything outside the markers verbatim.
 *   3. File exists without our markers → append the Adorable section
 *      after the existing content (with a blank-line separator).
 *
 * Markers are deliberately self-describing (`managed by veoable
 * install vscode`) so a user who finds them in a diff knows where they
 * came from.
 */
function upsertCopilotInstructions(filePath: string, section: string): void {
  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf-8');
  }

  // Match an existing managed region. We accept any historical start
  // marker form in COPILOT_START_MARKERS (so a v=0 install upgrades
  // to v=1 on next run, etc.) but always write the current form.
  const endEsc = COPILOT_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startAlt = COPILOT_START_MARKERS
    .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // `g` so we collapse any stale orphan marker pairs from a
  // half-completed previous install in one pass.
  const managed = new RegExp(`(?:${startAlt})[\\s\\S]*?${endEsc}`, 'g');

  let next: string;
  if (managed.test(existing)) {
    managed.lastIndex = 0; // reset (test() advanced it)
    // Replace the FIRST managed region with the canonical section, then
    // drop any other stray managed regions so we end with exactly one.
    let replacedFirst = false;
    next = existing.replace(managed, (match) => {
      if (!replacedFirst) {
        replacedFirst = true;
        return section;
      }
      return ''; // strip duplicates
    });
  } else if (existing.length > 0) {
    next = existing.trimEnd() + '\n\n' + section + '\n';
  } else {
    next = section + '\n';
  }
  fs.writeFileSync(filePath, next, 'utf-8');
}

/**
 * Read .vscode/mcp.json. Tolerant on missing-file / malformed JSON
 * (returns `{}`) so the merge always produces a valid output. Same
 * rationale as the Cursor / Continue readers.
 */
function readVSCodeMcpJson(jsonPath: string): { servers?: Record<string, unknown>; [k: string]: unknown } {
  if (!fs.existsSync(jsonPath)) return {};
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as { servers?: Record<string, unknown> };
  } catch {
    return {};
  }
}

/**
 * Install the Adorable skill into a VS Code workspace.
 *
 * Writes:
 *   - `<projectDir>/.github/copilot-instructions.md` — always. Upserts
 *     a delimited Adorable section; existing instructions outside the
 *     markers are preserved verbatim.
 *   - `<projectDir>/.vscode/mcp.json` — only when `db` is provided.
 *     Merges with existing `servers` to preserve any other servers the
 *     user has configured.
 *
 * VS Code's MCP config uses `servers` (not `mcpServers` like Cursor /
 * Continue) and requires `type: 'stdio'` on each entry — that's a
 * format quirk worth noting if you copy from another adapter.
 */
export function installVSCodeSkill(opts: InstallVSCodeOptions = {}): InstallResult {
  const projectDir = opts.projectDir ?? process.cwd();
  const ghDir = path.join(projectDir, '.github');
  fs.mkdirSync(ghDir, { recursive: true });

  const instructionsFile = path.join(ghDir, 'copilot-instructions.md');
  upsertCopilotInstructions(instructionsFile, buildCopilotInstructionsSection());

  const filesWritten = [instructionsFile];
  const nextSteps: string[] = [];

  if (opts.db) {
    const vscodeDir = path.join(projectDir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    const dbAbs = path.resolve(projectDir, opts.db);
    const mcpFile = path.join(vscodeDir, 'mcp.json');
    const existing = readVSCodeMcpJson(mcpFile);
    const servers = (existing.servers ?? {}) as Record<string, unknown>;
    servers[SKILL_NAME] = {
      type: 'stdio',
      command: 'veoable',
      args: ['serve', dbAbs],
    };
    const merged = { ...existing, servers };
    fs.writeFileSync(mcpFile, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    filesWritten.push(mcpFile);

    nextSteps.push(
      'Restart VS Code (or reload the window) so Copilot Chat picks up the new instructions and MCP server.',
      '',
      'Adorable will now answer architecture and flow questions in @workspace chat.',
      '',
      'For live updates during a session, leave a watcher running:',
      '  veoable project watch <project.json> --incremental --on-demand',
      "  (press 'r' before asking Copilot a question that needs fresh data)",
    );
  } else {
    nextSteps.push(
      "Build a graph for your project (if you haven't already):",
      '  veoable project init <path>',
      '  veoable project analyze <project.json>',
      '',
      'Re-run this command with --db to wire the MCP server entry:',
      '  veoable install vscode --db <project.db>',
      '',
      'Restart VS Code once both files are in place.',
    );
  }

  return {
    client: 'vscode',
    filesWritten,
    nextSteps,
  };
}

// ─────────────────────────────────────────────────────────────────────
// --auto detection + multi-install
// ─────────────────────────────────────────────────────────────────────

export interface InstallAutoOptions {
  /** Project directory for project-scoped clients (cursor). Defaults to cwd. */
  projectDir?: string;
  /** Path to a graph DB threaded into every detected client's installer. */
  db?: string;
  /** Env lookup for detection (HOME, CLAUDE_CONFIG_DIR, CONTINUE_GLOBAL_DIR). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Result of an auto-install run.
 *
 *   - `installed`: clients whose detection signal fired AND whose
 *     installer completed without throwing.
 *   - `skipped`: clients with no detection signal. The user is
 *     reminded how to install them explicitly.
 *   - `failed`: clients whose detection signal fired but whose
 *     installer threw. Best-effort semantics — one failure does not
 *     stop the rest of the loop, and the CLI surfaces every bucket
 *     so partial success is visible.
 */
export interface InstallAutoResult {
  installed: InstallResult[];
  skipped: Array<{ client: string; reason: string }>;
  failed: Array<{ client: string; error: string }>;
}

/**
 * Detect whether each supported client is installed locally and
 * install Adorable into every one that's detected. Skips clients
 * with no detection signal — we don't want to bootstrap a Cursor
 * project in a non-Cursor cwd, or create ~/.claude on a machine
 * that doesn't run Claude Code.
 *
 * Detection (each is a cheap fs check; no network):
 *   - claude-code: $CLAUDE_CONFIG_DIR exists, OR ~/.claude/ exists.
 *   - cursor: <projectDir>/.cursor/ exists (any cursor-config presence
 *     is treated as a "yes please install" signal). Without an
 *     existing .cursor we skip — running auto in a non-Cursor project
 *     shouldn't scatter configs.
 *   - continue: $CONTINUE_GLOBAL_DIR exists, OR ~/.continue/ exists.
 */
export function installAuto(opts: InstallAutoOptions = {}): InstallAutoResult {
  const env = opts.env ?? process.env;
  const home = env.HOME ?? os.homedir();
  const projectDir = opts.projectDir ?? process.cwd();

  const installed: InstallResult[] = [];
  const skipped: Array<{ client: string; reason: string }> = [];
  const failed: Array<{ client: string; error: string }> = [];

  // Best-effort runner: detected clients always attempt the install,
  // but a throw from any one adapter does not stop the rest of the
  // loop. The caller decides what to do with `failed` entries.
  const tryInstall = (client: string, run: () => InstallResult): void => {
    try {
      installed.push(run());
    } catch (err) {
      failed.push({
        client,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // claude-code
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  if (fs.existsSync(claudeDir)) {
    tryInstall('claude-code', () => installClaudeCodeSkill({ env }));
  } else {
    skipped.push({
      client: 'claude-code',
      reason: `${claudeDir} not found (Claude Code doesn't appear to be installed; run \`veoable install claude-code\` to set up anyway)`,
    });
  }

  // cursor
  const cursorRoot = path.join(projectDir, '.cursor');
  if (fs.existsSync(cursorRoot)) {
    tryInstall('cursor', () => installCursorSkill({ projectDir, db: opts.db }));
  } else {
    skipped.push({
      client: 'cursor',
      reason: `${cursorRoot} not found (this project isn't using Cursor yet; run \`veoable install cursor\` from the project root to set up)`,
    });
  }

  // continue
  const continueDir = env.CONTINUE_GLOBAL_DIR ?? path.join(home, '.continue');
  if (fs.existsSync(continueDir)) {
    tryInstall('continue', () => installContinueSkill({ env, db: opts.db }));
  } else {
    skipped.push({
      client: 'continue',
      reason: `${continueDir} not found (Continue doesn't appear to be installed; run \`veoable install continue\` to set up anyway)`,
    });
  }

  // vscode — project-scoped. Detected by .vscode/ in projectDir
  // (workspace settings root) OR an existing .github/copilot-instructions.md
  // (repo-level Copilot context). Both signals catch projects that have
  // ever used Copilot Chat; running --auto in a non-VSCode/Copilot
  // repo skips for the same reason cursor does.
  const vscodeRoot = path.join(projectDir, '.vscode');
  const copilotInstructions = path.join(projectDir, '.github', 'copilot-instructions.md');
  if (fs.existsSync(vscodeRoot) || fs.existsSync(copilotInstructions)) {
    tryInstall('vscode', () => installVSCodeSkill({ projectDir, db: opts.db }));
  } else {
    skipped.push({
      client: 'vscode',
      reason: `neither ${vscodeRoot} nor ${copilotInstructions} found (this project doesn't appear to use VS Code/Copilot; run \`veoable install vscode\` from the project root to set up)`,
    });
  }

  return { installed, skipped, failed };
}
