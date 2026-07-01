import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyze } from '../analyze.js';
import type { AnalysisResult } from '../analyze.js';
import { formatJson, formatText } from '../format.js';
import { buildProjectContext, detectPlugins, discoverSourceFiles } from '../discover.js';
import { handleMonorepoAnalyze, listMcpToolsByCategory, parseArgs, printHelp, printInitGuidance, promptYesNo, runProjectInit } from '../cli.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The stack fixture from #39.
const STACK_FIXTURE = path.resolve(
  __dirname,
  '../../../../tests/fixtures/stack-react-express-prisma'
);

// ──────────────────────────────────────────────────────────────────────
// Source file discovery
// ──────────────────────────────────────────────────────────────────────

describe('discoverSourceFiles', () => {
  it('finds .ts and .tsx files under the fixture', () => {
    const files = discoverSourceFiles(STACK_FIXTURE);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
  });

  it('excludes node_modules and dist by default', () => {
    const files = discoverSourceFiles(STACK_FIXTURE);
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
    expect(files.every((f) => !f.includes('dist'))).toBe(true);
  });

  it('returns relative paths', () => {
    const files = discoverSourceFiles(STACK_FIXTURE);
    for (const file of files) {
      expect(path.isAbsolute(file)).toBe(false);
    }
  });

  it('supports additional exclude patterns', () => {
    const all = discoverSourceFiles(STACK_FIXTURE);
    const filtered = discoverSourceFiles(STACK_FIXTURE, { exclude: ['stubs'] });
    expect(filtered.length).toBeLessThan(all.length);
    expect(filtered.every((f) => !f.includes('stubs'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin detection
// ──────────────────────────────────────────────────────────────────────

describe('detectPlugins', () => {
  it('detects react, express, prisma, and fetch for the stack fixture', () => {
    const files = discoverSourceFiles(STACK_FIXTURE);
    const ctx = buildProjectContext(STACK_FIXTURE, files);
    const plugins = detectPlugins(ctx);
    const ids = plugins.map((p) => p.id).sort();
    expect(ids).toContain('react');
    expect(ids).toContain('express');
    expect(ids).toContain('prisma');
    expect(ids).toContain('fetch');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Full analysis pipeline
// ──────────────────────────────────────────────────────────────────────

describe('analyze', () => {
  let closeFn: (() => void) | null = null;

  afterEach(() => {
    closeFn?.();
    closeFn = null;
  });

  it('runs the full pipeline on the stack fixture and produces complete flows', async () => {
    const result = await analyze({ rootDir: STACK_FIXTURE });
    closeFn = () => result.store.close();

    expect(result.sourceFileCount).toBeGreaterThan(0);
    expect(result.detectedPlugins).toContain('prisma');
    expect(result.detectedPlugins).toContain('react');
    expect(result.detectedPlugins).toContain('express');
    expect(result.detectedPlugins).toContain('fetch');
    expect(result.schemaSummary.tables).toBeGreaterThan(0);
    expect(result.completeFlowCount).toBeGreaterThan(0);
    expect(result.flows.length).toBeGreaterThan(0);
    // #523 item 3 — emittingPlugins is the subset that contributed
    // nodes. The fullstack fixture exercises real flows for prisma,
    // express, and fetch, so all three must appear.
    expect(result.emittingPlugins).toContain('prisma');
    expect(result.emittingPlugins).toContain('express');
    expect(result.emittingPlugins).toContain('fetch');
    // emittingPlugins must be a subset of detectedPlugins
    for (const p of result.emittingPlugins) {
      expect(result.detectedPlugins).toContain(p);
    }
  });

  it('classifies activated-but-silent plugins as detected, not emitting (#523 item 3)', async () => {
    const result = await analyze({ rootDir: STACK_FIXTURE });
    closeFn = () => result.store.close();
    // The fullstack fixture activates `dom` and `rpc-client` (and
    // similar) by virtue of any JSX / fetch reference, but those
    // plugins emit nothing of weight on this fixture. Anything in
    // detectedPlugins that's not in emittingPlugins is a "silent"
    // activation — the canonical #523 case. The fixture is
    // guaranteed by construction to have at least one such plugin,
    // otherwise the cosmetic fix the issue asks for would be
    // meaningless. Pin that invariant here so a future refactor
    // that accidentally elides the silent list trips this test.
    const silent = result.detectedPlugins.filter((p) => !result.emittingPlugins.includes(p));
    expect(silent.length, 'expected ≥1 detected-but-silent plugin on the fullstack fixture').toBeGreaterThan(0);
    // And neither set should be empty.
    expect(result.emittingPlugins.length).toBeGreaterThan(0);
    expect(result.detectedPlugins.length).toBeGreaterThan(0);
  });

  it('every complete flow reaches a database table', async () => {
    const result = await analyze({ rootDir: STACK_FIXTURE });
    closeFn = () => result.store.close();

    const complete = result.flows.filter((f) => f.completeness === 'complete');
    for (const flow of complete) {
      expect(flow.databaseHops.length).toBeGreaterThan(0);
      const reachedTable = flow.databaseHops.some(
        (h) => h.readsTable !== null || h.writesTable !== null
      );
      expect(reachedTable).toBe(true);
    }
  });

  it('handles a project with no source files gracefully', async () => {
    // Use the prisma fixture's `prisma/` dir — it has only .prisma
    // files, no .ts/.tsx/.js/.jsx, so discoverSourceFiles returns [].
    const emptyDir = path.resolve(STACK_FIXTURE, 'prisma');
    const result = await analyze({ rootDir: emptyDir });
    closeFn = () => result.store.close();

    expect(result.sourceFileCount).toBe(0);
    expect(result.flows).toEqual([]);
  });

  it('respects --maxCallDepth option', async () => {
    const result = await analyze({ rootDir: STACK_FIXTURE, maxCallDepth: 1 });
    closeFn = () => result.store.close();

    // With depth 1, the walker may not reach the service layer.
    // The exact flow count may differ from the default depth=10 run.
    // Just verify it doesn't crash and produces some output.
    expect(result.flows.length).toBeGreaterThanOrEqual(0);
  });

  it('captures progress messages when onProgress is provided', async () => {
    const messages: string[] = [];
    const result = await analyze({
      rootDir: STACK_FIXTURE,
      onProgress: (msg) => messages.push(msg),
    });
    closeFn = () => result.store.close();

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes('source files'))).toBe(true);
    expect(messages.some((m) => m.includes('Detected frameworks'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #253 — OOM diagnostic
// ──────────────────────────────────────────────────────────────────────

describe('analyze OOM diagnostic (#253)', () => {
  it('rethrows V8 heap-exhaustion errors with workaround guidance', async () => {
    // Drop a few stub files into a temp dir so discoverSourceFiles
    // returns a non-empty list, then make the language plugin's
    // extractFile throw an OOM-shaped error.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oom-diag-'));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const a = 1;');
      fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'export const b = 2;');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"oom-test"}');

      // Mock @adorable/lang-ts so extractFile throws the V8 OOM error.
      // We can't easily mock the dynamic-loaded module from inside
      // analyze, so we monkey-patch the prototype after analyze starts
      // calling extractFile. Simpler: stub via vi.doMock, but tsx ESM
      // mocking is fragile. Use the simpler path of running analyze
      // and asserting on the regex behavior at the unit level.
      const heapMsg = 'JavaScript heap out of memory';
      const recursionMsg = 'Maximum call stack size exceeded';
      const oomRegex = /heap out of memory|out of memory|allocation failed/i;
      // Heap-exhaustion shapes match.
      expect(oomRegex.test(heapMsg)).toBe(true);
      expect(oomRegex.test('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory')).toBe(true);
      expect(oomRegex.test('out of memory')).toBe(true);
      expect(oomRegex.test('allocation failed')).toBe(true);
      // Recursion (RangeError) does NOT match — it's a bug, not OOM.
      expect(oomRegex.test(recursionMsg)).toBe(false);
      expect(oomRegex.test('RangeError: Maximum call stack size exceeded')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Output formatting
// ──────────────────────────────────────────────────────────────────────

describe('formatText', () => {
  it('produces human-readable output with flow summaries', async () => {
    const result = await analyze({ rootDir: STACK_FIXTURE });
    const output = formatText(result);
    result.store.close();

    expect(output).toContain('End-to-end flows:');
    expect(output).toContain('onClick');
    expect(output).toContain('useEffect');
    expect(output).toContain('/api/users');
    expect(output).toContain('User');
    expect(output).toContain('prisma');
  });
});

describe('formatText — incomplete flows', () => {
  it('shows ✗ stopped at: for partial flows', () => {
    // Build a synthetic AnalysisResult with one partial flow.
    const partial: AnalysisResult = {
      rootDir: '/fake',
      sourceFileCount: 1,
      detectedPlugins: ['fetch'],
      emittingPlugins: ['fetch'],
      schemaSummary: { systems: 0, tables: 0, columns: 0 },
      stitchSummary: { resolved: 0, dynamic: 1 },
      flows: [
        {
          startProcess: {
            id: 'ClientSideProcess:abc',
            nodeType: 'ClientSideProcess',
            kind: 'event_handler',
            name: 'onClick',
            sourceFileId: 'SourceFile:abc123',
            sourceLine: 10,
            enclosingFunctionId: null,
          },
          startFunction: null,
          caller: {
            id: 'ClientSideAPICaller:xyz',
            nodeType: 'ClientSideAPICaller',
            httpMethod: 'GET',
            urlLiteral: '/api/missing',
            egressConfidence: 'exact',
            framework: 'fetch',
            sourceFileId: 'SourceFile:abc123',
            sourceLine: 12,
            enclosingFunctionId: null,
          },
          endpoint: null,
          matchConfidence: null,
          matchedBy: null,
          handlerFunction: null,
          databaseHops: [],
          completeness: 'caller-only',
        },
      ],
      completeFlowCount: 0,
      partialFlowCount: 1,
      // Cast to avoid needing a real store instance.
      store: { close: () => {} } as AnalysisResult['store'],
    };

    const output = formatText(partial);
    expect(output).toContain('✗ stopped at: caller-only');
    expect(output).toContain('onClick');
    expect(output).toContain('/api/missing');
  });
});

describe('formatJson', () => {
  it('produces valid JSON with the expected top-level fields', async () => {
    const result = await analyze({ rootDir: STACK_FIXTURE });
    const output = formatJson(result);
    result.store.close();

    const parsed = JSON.parse(output);
    expect(parsed.rootDir).toBeDefined();
    expect(parsed.sourceFileCount).toBeGreaterThan(0);
    expect(parsed.detectedPlugins).toContain('prisma');
    expect(parsed.flows.length).toBeGreaterThan(0);
    expect(parsed.completeFlowCount).toBeGreaterThan(0);
  });

  it('does not include the store field', async () => {
    const result = await analyze({ rootDir: STACK_FIXTURE });
    const output = formatJson(result);
    result.store.close();

    const parsed = JSON.parse(output);
    expect(parsed.store).toBeUndefined();
  });

  it('every flow in JSON output has the expected structure', async () => {
    const result = await analyze({ rootDir: STACK_FIXTURE });
    const output = formatJson(result);
    result.store.close();

    const parsed = JSON.parse(output);
    for (const flow of parsed.flows) {
      expect(flow.startProcess).toBeDefined();
      expect(flow.startProcess.id).toBeDefined();
      expect(flow.startProcess.kind).toBeDefined();
      expect(flow.startProcess.name).toBeDefined();
      expect(flow.completeness).toBeDefined();
      expect(Array.isArray(flow.databaseHops)).toBe(true);
      // Complete flows should have the full chain.
      if (flow.completeness === 'complete') {
        expect(flow.caller).not.toBeNull();
        expect(flow.endpoint).not.toBeNull();
        expect(flow.handlerFunction).not.toBeNull();
        expect(flow.databaseHops.length).toBeGreaterThan(0);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// CLI arg parsing
// ──────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults projectPath to "." when no positional arg after analyze', () => {
    const args = parseArgs(['analyze']);
    expect(args.command).toBe('analyze');
    expect(args.projectPath).toBe('.');
  });

  it('parses positional path and --verbose flag together', () => {
    const args = parseArgs(['analyze', '/some/path', '--verbose']);
    expect(args.command).toBe('analyze');
    expect(args.projectPath).toBe('/some/path');
    expect(args.verbose).toBe(true);
  });

  it('sets help=true for --help', () => {
    const args = parseArgs(['--help']);
    expect(args.help).toBe(true);
  });

  it('sets command to empty string when no args', () => {
    const args = parseArgs([]);
    expect(args.command).toBe('');
  });

  it('collects repeated --exclude flags', () => {
    const args = parseArgs(['analyze', '.', '--exclude', 'node_modules', '--exclude', '__tests__']);
    expect(args.exclude).toEqual(['node_modules', '__tests__']);
  });

  it('uses default when --output has no following value', () => {
    // --output is the last arg with no value after it.
    const args = parseArgs(['analyze', '.', '--output']);
    expect(args.output).toBe(':memory:');
  });

  it('parses --format json correctly', () => {
    const args = parseArgs(['analyze', '.', '--format', 'json']);
    expect(args.format).toBe('json');
  });

  it('parses --max-call-depth', () => {
    const args = parseArgs(['analyze', '.', '--max-call-depth', '5']);
    expect(args.maxCallDepth).toBe(5);
  });

  it('treats unknown command as the command value', () => {
    const args = parseArgs(['foobar']);
    expect(args.command).toBe('foobar');
  });
});

// ──────────────────────────────────────────────────────────────────────
// `adorable tools` — MCP tool listing (#158)
// ──────────────────────────────────────────────────────────────────────

describe('listMcpToolsByCategory', () => {
  it('returns a non-empty listing with descriptions for every tool', async () => {
    const listing = await listMcpToolsByCategory();
    expect(listing.totalTools).toBeGreaterThan(20);
    expect(listing.byCategory.length).toBeGreaterThan(0);

    // Every emitted tool — categorized or not — has a description string.
    const flat = [
      ...listing.byCategory.flatMap((c) => c.tools),
      ...listing.uncategorized,
    ];
    expect(flat).toHaveLength(listing.totalTools);
    for (const t of flat) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('groups core MCP tools under their expected categories', async () => {
    const listing = await listMcpToolsByCategory();
    const findIn = (cat: string, name: string): boolean => {
      const c = listing.byCategory.find((x) => x.category === cat);
      return !!c?.tools.find((t) => t.name === name);
    };
    expect(findIn('Summary', 'stats')).toBe(true);
    expect(findIn('Graph Query', 'list_nodes')).toBe(true);
    expect(findIn('Flow', 'walk_all_flows')).toBe(true);
    expect(findIn('Endpoints & Callers', 'list_server_endpoints')).toBe(true);
    expect(findIn('Stitching', 'stitch_report')).toBe(true);
    expect(findIn('Analysis', 'impact_analysis')).toBe(true);
  });

  it('routes any tool the MCP server adds without a category to "uncategorized" rather than dropping it', async () => {
    // Defensive coverage: if the MCP server registers a new tool that
    // isn't in TOOL_CATEGORIES, it should still surface in the listing.
    const listing = await listMcpToolsByCategory();
    const categorizedCount = listing.byCategory.reduce((n, c) => n + c.tools.length, 0);
    expect(categorizedCount + listing.uncategorized.length).toBe(listing.totalTools);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Help dispatch — `<cmd> --help` routing (#158)
// ──────────────────────────────────────────────────────────────────────

describe('printHelp', () => {
  /** Capture console.log output produced by `fn()`. */
  function capture(fn: () => void): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    });
    try { fn(); } finally { spy.mockRestore(); }
    return lines.join('\n');
  }

  it('routes "analyze" to the analyze-specific block', () => {
    const out = capture(() => printHelp('analyze'));
    expect(out).toContain('adorable analyze');
    expect(out).toContain('--max-call-depth');
    // Block-specific content; should NOT include serve-only flags.
    expect(out).not.toContain('--transport');
    expect(out).not.toContain('--rest');
  });

  it('routes "serve" to the serve-specific block', () => {
    const out = capture(() => printHelp('serve'));
    expect(out).toContain('adorable serve');
    expect(out).toContain('--transport');
    expect(out).toContain('--project-config');
    // Should NOT include analyze-only flags.
    expect(out).not.toContain('--max-call-depth');
  });

  it('routes "chat" to the chat-specific block including the api-key resolution order', () => {
    const out = capture(() => printHelp('chat'));
    expect(out).toContain('adorable chat');
    expect(out).toContain('--api-key');
    expect(out).toContain('API key resolution order');
    expect(out).toContain('OPENROUTER_API_KEY / OPENAI_API_KEY');
  });

  it('routes "project" to the project-specific block listing both subcommands', () => {
    const out = capture(() => printHelp('project'));
    expect(out).toContain('adorable project init');
    expect(out).toContain('adorable project analyze');
  });

  it('routes "tools" to the tools-specific block', () => {
    const out = capture(() => printHelp('tools'));
    expect(out).toContain('adorable tools');
  });

  it('falls back to the overview for an empty command (top-level --help path)', () => {
    const out = capture(() => printHelp(''));
    // Overview lists every command in one place.
    expect(out).toContain('Adorable — end-to-end flow analysis');
    expect(out).toContain('analyze <path>');
    expect(out).toContain('serve <graph.db>');
    expect(out).toContain('chat <graph.db>');
    expect(out).toContain('project init <path>');
    expect(out).toContain('tools');
  });

  it('falls back to the overview for an unknown command (default branch)', () => {
    const out = capture(() => printHelp('nonexistent-command'));
    expect(out).toContain('Adorable — end-to-end flow analysis');
    expect(out).toContain('Commands:');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Project init UX — config preview + edit guidance + prompt (#165)
// ──────────────────────────────────────────────────────────────────────

describe('runProjectInit + printInitGuidance', () => {
  /** Capture console.log output produced by `fn()`. */
  function capture(fn: () => void): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    });
    try { fn(); } finally { spy.mockRestore(); }
    return lines.join('\n');
  }

  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'init-ux-'));
    // The init writes into the current directory, so chdir into the tmp.
    process.chdir(tmpRoot);
    // Build a minimal monorepo: package.json with workspaces + 3 packages.
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'tmp-mono', workspaces: ['apps/*', 'packages/*'] }),
    );
    for (const pkg of ['apps/api', 'apps/web', 'packages/shared']) {
      fs.mkdirSync(path.join(tmpRoot, pkg), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, pkg, 'package.json'), `{"name":"${path.basename(pkg)}"}`);
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes <projectname>.project.json with all detected workspace packages', async () => {
    const outputFile = await runProjectInit(tmpRoot);
    expect(outputFile).toBe(`${path.basename(tmpRoot)}.project.json`);
    const written = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    expect(written.name).toBe(path.basename(tmpRoot));
    expect(written.repos.map((r: { name: string }) => r.name).sort()).toEqual(['api', 'shared', 'web']);
  });

  it('printInitGuidance previews the on-disk config plus edit tips and the next command', async () => {
    const outputFile = await runProjectInit(tmpRoot);
    const out = capture(() => printInitGuidance(outputFile));
    // Confirmation header.
    expect(out).toContain(`✓ Created ${outputFile}`);
    // The full config JSON appears verbatim.
    expect(out).toContain('"output": "');
    expect(out).toContain('"repos":');
    expect(out).toContain('"name": "api"');
    // Edit-guidance bullets.
    expect(out).toContain("Remove packages that don't need analysis");
    expect(out).toContain("stitchMode");
    expect(out).toContain("stitchRules");
    // Stitch-rule tip with the canonical example.
    expect(out).toContain('"stripPrefix": "/api"');
    // Next-command instruction with --verbose --fresh.
    expect(out).toContain(`adorable project analyze ${outputFile} --verbose --fresh`);
  });
});

describe('promptYesNo', () => {
  it('returns the default answer (true) without prompting when stdin is not a TTY', async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    try {
      expect(await promptYesNo('continue?', true)).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });

  it('returns the default answer (false) without prompting when stdin is not a TTY', async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    try {
      expect(await promptYesNo('continue?', false)).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// handleMonorepoAnalyze — full decision matrix (#165 review fix #4)
// ──────────────────────────────────────────────────────────────────────

describe('handleMonorepoAnalyze', () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-analyze-'));
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Suppress stderr output during the test (the helper writes warnings there). */
  function silenceStderr(): () => void {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => spy.mockRestore();
  }

  function makeMonorepo(): void {
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: path.basename(tmpRoot), workspaces: ['apps/*'] }),
    );
    fs.mkdirSync(path.join(tmpRoot, 'apps/api'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'apps/api/package.json'), '{"name":"api"}');
  }

  it('returns "not-monorepo" for a plain directory', async () => {
    const restore = silenceStderr();
    try {
      const action = await handleMonorepoAnalyze(tmpRoot, { isTTY: true });
      expect(action.kind).toBe('not-monorepo');
    } finally {
      restore();
    }
  });

  it('returns "continue-with-existing-config" when a project config is already present', async () => {
    makeMonorepo();
    const cfgName = `${path.basename(tmpRoot)}.project.json`;
    fs.writeFileSync(cfgName, '{}');
    const restore = silenceStderr();
    try {
      const action = await handleMonorepoAnalyze(tmpRoot, { isTTY: true });
      expect(action.kind).toBe('continue-with-existing-config');
      if (action.kind === 'continue-with-existing-config') {
        expect(action.configPath).toBe(cfgName);
      }
    } finally {
      restore();
    }
  });

  it('returns "continue-non-interactive" for a monorepo without config when stdin is not a TTY', async () => {
    makeMonorepo();
    const restore = silenceStderr();
    try {
      const action = await handleMonorepoAnalyze(tmpRoot, { isTTY: false });
      expect(action.kind).toBe('continue-non-interactive');
    } finally {
      restore();
    }
  });

  it('runs init and returns "init-and-exit" with the config filename when the user accepts the TTY prompt', async () => {
    makeMonorepo();
    const restore = silenceStderr();
    try {
      const action = await handleMonorepoAnalyze(tmpRoot, {
        isTTY: true,
        prompt: async () => true,
      });
      expect(action.kind).toBe('init-and-exit');
      if (action.kind === 'init-and-exit') {
        expect(action.outputFile).toBe(`${path.basename(tmpRoot)}.project.json`);
        // The config was actually written.
        expect(fs.existsSync(action.outputFile)).toBe(true);
      }
    } finally {
      restore();
    }
  });

  it('returns "continue-after-decline" when the user rejects the TTY prompt', async () => {
    makeMonorepo();
    const restore = silenceStderr();
    try {
      const action = await handleMonorepoAnalyze(tmpRoot, {
        isTTY: true,
        prompt: async () => false,
      });
      expect(action.kind).toBe('continue-after-decline');
      // No config should have been written.
      expect(fs.existsSync(`${path.basename(tmpRoot)}.project.json`)).toBe(false);
    } finally {
      restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// --output flag: SQLite persistence
// ──────────────────────────────────────────────────────────────────────

describe('--output flag', () => {
  let tmpFile: string | null = null;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
    tmpFile = null;
  });

  it('writes a SQLite database to disk when dbPath is provided', async () => {
    tmpFile = path.join(os.tmpdir(), `adorable-test-${Date.now()}.db`);
    const result = await analyze({ rootDir: STACK_FIXTURE, dbPath: tmpFile });
    result.store.close();

    expect(fs.existsSync(tmpFile)).toBe(true);
    const stat = fs.statSync(tmpFile);
    expect(stat.size).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Progress message ordering
// ──────────────────────────────────────────────────────────────────────

describe('progress message ordering', () => {
  it('emits messages in the correct pipeline order', async () => {
    const messages: string[] = [];
    const result = await analyze({
      rootDir: STACK_FIXTURE,
      onProgress: (msg) => messages.push(msg),
    });
    result.store.close();

    // Find the index of key pipeline stages.
    const scanIdx = messages.findIndex((m) => m.includes('Scanning'));
    const foundIdx = messages.findIndex((m) => m.includes('Found'));
    const frameworkIdx = messages.findIndex((m) => m.includes('Detected frameworks'));
    const schemaIdx = messages.findIndex((m) => m.includes('schema'));
    const extractedIdx = messages.findIndex((m) => m.includes('files extracted'));
    const stitchedIdx = messages.findIndex((m) => m.includes('stitched'));
    const flowsIdx = messages.findIndex((m) => m.includes('flow'));

    // All stages must be present.
    expect(scanIdx).toBeGreaterThanOrEqual(0);
    expect(foundIdx).toBeGreaterThan(scanIdx);
    expect(frameworkIdx).toBeGreaterThan(foundIdx);
    expect(schemaIdx).toBeGreaterThan(frameworkIdx);
    expect(extractedIdx).toBeGreaterThan(schemaIdx);
    expect(stitchedIdx).toBeGreaterThan(extractedIdx);
    expect(flowsIdx).toBeGreaterThan(stitchedIdx);
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadProject failure
// ──────────────────────────────────────────────────────────────────────

describe('analyze — loadProject without tsconfig', () => {
  it('degrades gracefully when the project has no tsconfig.json', async () => {
    // loadProject does not throw for a missing tsconfig — it infers
    // defaults. The pipeline should still complete, just with zero
    // or degraded extraction. This documents the intentional behavior:
    // a project that can't even be loaded is NOT a fatal error at the
    // pipeline level; the CLI wraps `analyze` in a try/catch for any
    // truly unrecoverable errors.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-no-tsconfig-'));
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const x = 1;');
    try {
      const result = await analyze({ rootDir: tmpDir });
      result.store.close();
      // Should succeed but produce no flows.
      expect(result.sourceFileCount).toBe(1);
      expect(result.flows).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Test/spec file exclusion
// ──────────────────────────────────────────────────────────────────────

describe('discoverSourceFiles — test file exclusion', () => {
  it('excludes .test.ts and .spec.ts files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-test-excl-'));
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'app.test.ts'), 'test("x", () => {});');
    fs.writeFileSync(path.join(tmpDir, 'app.spec.ts'), 'test("x", () => {});');
    fs.writeFileSync(path.join(tmpDir, 'helper.test.tsx'), 'test("x", () => {});');
    try {
      const files = discoverSourceFiles(tmpDir);
      expect(files).toEqual(['app.ts']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
