import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installAuto,
  installClaudeCodeSkill,
  installContinueSkill,
  installCursorSkill,
  installVSCodeSkill,
} from '../install.js';

/**
 * Tests for #363 install adapters — Claude Code (user-scoped),
 * Cursor (project-scoped), and Continue (user-scoped). Every adapter
 * takes explicit dir options so tests never touch the user's real
 * configs.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veoable-install-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('installClaudeCodeSkill (#363)', () => {
  it('writes SKILL.md into the target dir', () => {
    const result = installClaudeCodeSkill({ dir: tmpRoot });
    expect(result.client).toBe('claude-code');
    expect(result.filesWritten).toHaveLength(1);

    const skillPath = path.join(tmpRoot, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(result.filesWritten[0]).toBe(skillPath);

    const written = fs.readFileSync(skillPath, 'utf-8');
    // Frontmatter survived the write.
    expect(written.startsWith('---\nname: veoable')).toBe(true);
    // Full content (not a truncated copy).
    expect(written.length).toBeGreaterThan(5000);
    // Load-bearing routing sections present — pins the same contract
    // as the describe_skill test, but downstream of disk persistence.
    expect(written).toContain('## When to invoke this skill');
    expect(written).toContain('## When NOT to invoke this skill');
    expect(written).toContain('## How to use the tools well');
  });

  it('creates the target directory if missing', () => {
    const deepDir = path.join(tmpRoot, 'a', 'b', 'c');
    expect(fs.existsSync(deepDir)).toBe(false);

    installClaudeCodeSkill({ dir: deepDir });

    expect(fs.existsSync(deepDir)).toBe(true);
    expect(fs.existsSync(path.join(deepDir, 'SKILL.md'))).toBe(true);
  });

  it('is idempotent — re-running overwrites with current content', () => {
    installClaudeCodeSkill({ dir: tmpRoot });
    const skillPath = path.join(tmpRoot, 'SKILL.md');

    // Mutate the file to simulate an older / corrupted version.
    fs.writeFileSync(skillPath, 'stale content\n', 'utf-8');
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('stale content\n');

    const result = installClaudeCodeSkill({ dir: tmpRoot });
    expect(result.filesWritten[0]).toBe(skillPath);

    const written = fs.readFileSync(skillPath, 'utf-8');
    expect(written.startsWith('---\nname: veoable')).toBe(true);
    expect(written.length).toBeGreaterThan(5000);
  });

  it('returns next-step instructions for analyze + claude mcp add + watch', () => {
    const { nextSteps } = installClaudeCodeSkill({ dir: tmpRoot });
    const joined = nextSteps.join('\n');
    // The instructions thread the user from install -> analyzed graph ->
    // registered MCP server -> live updates. All three steps are the
    // load-bearing flow; missing any of them leaves a new user stuck.
    expect(joined).toContain('veoable project init');
    expect(joined).toContain('veoable project analyze');
    expect(joined).toContain('claude mcp add veoable');
    expect(joined).toContain('veoable project watch');
  });

  it('honors $CLAUDE_CONFIG_DIR when set and dir is omitted', () => {
    const fakeConfig = path.join(tmpRoot, 'fake-claude-config');
    fs.mkdirSync(fakeConfig);
    const result = installClaudeCodeSkill({
      env: { CLAUDE_CONFIG_DIR: fakeConfig },
    });
    const expected = path.join(fakeConfig, 'skills', 'veoable', 'SKILL.md');
    expect(result.filesWritten[0]).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('explicit dir wins over $CLAUDE_CONFIG_DIR when both are supplied', () => {
    const envConfig = path.join(tmpRoot, 'env-config');
    fs.mkdirSync(envConfig);
    const explicitDir = path.join(tmpRoot, 'explicit');

    const result = installClaudeCodeSkill({
      dir: explicitDir,
      env: { CLAUDE_CONFIG_DIR: envConfig },
    });

    // dir wins -> file lands in explicit, NOT in env-config.
    expect(result.filesWritten[0]).toBe(path.join(explicitDir, 'SKILL.md'));
    expect(fs.existsSync(path.join(explicitDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(envConfig, 'skills', 'veoable', 'SKILL.md'))).toBe(false);
  });

  it('falls back to $HOME/.claude/skills/veoable when no overrides given', () => {
    const fakeHome = path.join(tmpRoot, 'fake-home');
    fs.mkdirSync(fakeHome);
    const result = installClaudeCodeSkill({
      env: { HOME: fakeHome },
    });
    const expected = path.join(fakeHome, '.claude', 'skills', 'veoable', 'SKILL.md');
    expect(result.filesWritten[0]).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });
});

describe('installCursorSkill (#363)', () => {
  it('writes .cursor/rules/veoable.mdc into the project dir', () => {
    const result = installCursorSkill({ projectDir: tmpRoot });
    expect(result.client).toBe('cursor');
    // Without --db, only the rule file is written.
    expect(result.filesWritten).toHaveLength(1);

    const rulePath = path.join(tmpRoot, '.cursor', 'rules', 'veoable.mdc');
    expect(result.filesWritten[0]).toBe(rulePath);
    expect(fs.existsSync(rulePath)).toBe(true);
  });

  it('rule file uses Cursor-format frontmatter, not SKILL.md frontmatter', () => {
    installCursorSkill({ projectDir: tmpRoot });
    const written = fs.readFileSync(
      path.join(tmpRoot, '.cursor', 'rules', 'veoable.mdc'),
      'utf-8',
    );
    // First three lines must be the Cursor frontmatter, NOT
    // SKILL.md's `name: veoable` opener.
    expect(written.startsWith('---\ndescription: ')).toBe(true);
    expect(written).toContain('\nalwaysApply: false\n');
    expect(written).not.toContain('name: veoable');
    // Body survived intact.
    expect(written).toContain('## When to invoke this skill');
    expect(written).toContain('## When NOT to invoke this skill');
    expect(written).toContain('## How to use the tools well');
  });

  it('without --db, prints next-steps to re-run with --db', () => {
    const { filesWritten, nextSteps } = installCursorSkill({ projectDir: tmpRoot });
    // No .cursor/mcp.json written without --db.
    expect(fs.existsSync(path.join(tmpRoot, '.cursor', 'mcp.json'))).toBe(false);
    expect(filesWritten.some((f) => f.endsWith('mcp.json'))).toBe(false);

    const joined = nextSteps.join('\n');
    expect(joined).toContain('veoable install cursor --db');
    expect(joined).toContain('veoable project analyze');
  });

  it('with --db, writes .cursor/mcp.json with the veoable entry pointing at the absolute path', () => {
    const dbRel = 'project.db';
    const dbAbs = path.resolve(tmpRoot, dbRel);
    // We deliberately pass the relative form; the install must
    // normalize to absolute so Cursor reads the right file
    // regardless of where it cwd's from.
    const result = installCursorSkill({ projectDir: tmpRoot, db: path.join(tmpRoot, dbRel) });
    expect(result.filesWritten).toHaveLength(2);

    const mcpPath = path.join(tmpRoot, '.cursor', 'mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(cfg.mcpServers).toBeTruthy();
    expect(cfg.mcpServers.veoable).toEqual({
      command: 'veoable',
      args: ['serve', dbAbs],
    });
  });

  it('merges with existing mcp.json instead of overwriting other servers', () => {
    // Pre-seed mcp.json with another MCP server entry.
    fs.mkdirSync(path.join(tmpRoot, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'existing-server': {
            command: 'someone-else',
            args: ['run'],
          },
        },
      }, null, 2),
      'utf-8',
    );

    installCursorSkill({ projectDir: tmpRoot, db: path.join(tmpRoot, 'p.db') });

    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.cursor', 'mcp.json'), 'utf-8'),
    );
    // Other servers preserved.
    expect(cfg.mcpServers['existing-server']).toEqual({
      command: 'someone-else',
      args: ['run'],
    });
    // Veoable entry added alongside.
    expect(cfg.mcpServers.veoable).toBeTruthy();
    expect(cfg.mcpServers.veoable.command).toBe('veoable');
  });

  it('is idempotent — re-running with --db rewrites the veoable entry without disturbing others', () => {
    installCursorSkill({ projectDir: tmpRoot, db: path.join(tmpRoot, 'first.db') });

    // Inject an unrelated entry between runs to confirm it survives.
    const mcpPath = path.join(tmpRoot, '.cursor', 'mcp.json');
    const cfg1 = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    cfg1.mcpServers['other'] = { command: 'x', args: [] };
    fs.writeFileSync(mcpPath, JSON.stringify(cfg1, null, 2), 'utf-8');

    // Re-install with a different DB path.
    installCursorSkill({ projectDir: tmpRoot, db: path.join(tmpRoot, 'second.db') });

    const cfg2 = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(cfg2.mcpServers.veoable.args).toEqual([
      'serve',
      path.resolve(tmpRoot, 'second.db'),
    ]);
    // The unrelated entry must still be present.
    expect(cfg2.mcpServers.other).toEqual({ command: 'x', args: [] });
  });

  it('creates .cursor/rules deep dir if missing', () => {
    expect(fs.existsSync(path.join(tmpRoot, '.cursor'))).toBe(false);
    installCursorSkill({ projectDir: tmpRoot });
    expect(fs.existsSync(path.join(tmpRoot, '.cursor', 'rules'))).toBe(true);
  });

  it('resolves a relative --db against projectDir, not cwd', () => {
    // Run the install with a relative --db AND a non-cwd projectDir.
    // Without the projectDir-relative resolution, the path baked into
    // mcp.json would point at <cwd>/p.db (likely garbage in tests).
    const cfgPath = path.join(tmpRoot, '.cursor', 'mcp.json');
    installCursorSkill({ projectDir: tmpRoot, db: 'p.db' });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.mcpServers.veoable.args).toEqual([
      'serve',
      path.join(tmpRoot, 'p.db'),
    ]);
  });

  it('leaves an absolute --db absolute (path.resolve identity)', () => {
    const abs = path.join(tmpRoot, 'sub', 'absolute.db');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    installCursorSkill({ projectDir: tmpRoot, db: abs });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.cursor', 'mcp.json'), 'utf-8'),
    );
    expect(cfg.mcpServers.veoable.args).toEqual(['serve', abs]);
  });
});

describe('installContinueSkill (#363)', () => {
  it('creates ~/.continue/config.json from scratch with the /veoable slash command', () => {
    const result = installContinueSkill({ continueDir: tmpRoot });
    expect(result.client).toBe('continue');
    expect(result.filesWritten).toHaveLength(1);

    const cfgPath = path.join(tmpRoot, 'config.json');
    expect(result.filesWritten[0]).toBe(cfgPath);
    expect(fs.existsSync(cfgPath)).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.customCommands).toHaveLength(1);
    const cmd = cfg.customCommands[0];
    expect(cmd.name).toBe('veoable');
    expect(cmd.description.length).toBeGreaterThan(50);
    // The slash command prompt is the SKILL.md body, not the YAML
    // frontmatter — verify by checking we kept the body's section
    // headings but stripped `name: veoable` from the front.
    expect(cmd.prompt).not.toContain('name: veoable');
    expect(cmd.prompt).toContain('## When to invoke this skill');
    expect(cmd.prompt).toContain('## How to use the tools well');
  });

  it('without --db, the mcpServers section has no veoable entry', () => {
    installContinueSkill({ continueDir: tmpRoot });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'config.json'), 'utf-8'),
    );
    expect(cfg.mcpServers).toEqual({});
  });

  it('with --db, mcpServers.veoable is wired with absolute path', () => {
    const dbAbs = path.join(tmpRoot, 'graph.db');
    installContinueSkill({ continueDir: tmpRoot, db: dbAbs });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'config.json'), 'utf-8'),
    );
    expect(cfg.mcpServers.veoable).toEqual({
      command: 'veoable',
      args: ['serve', dbAbs],
    });
  });

  it('merges with existing config.json — preserves other commands + servers + top-level keys', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config.json'),
      JSON.stringify({
        models: [{ title: 'gpt-4', provider: 'openai' }],
        customCommands: [
          { name: 'preexisting', prompt: 'keep me', description: 'untouched' },
        ],
        mcpServers: { 'other-mcp': { command: 'x', args: [] } },
      }, null, 2),
      'utf-8',
    );

    installContinueSkill({ continueDir: tmpRoot, db: path.join(tmpRoot, 'g.db') });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'config.json'), 'utf-8'),
    );
    // Other top-level key (models) preserved verbatim.
    expect(cfg.models).toEqual([{ title: 'gpt-4', provider: 'openai' }]);
    // Other customCommand preserved.
    const names = (cfg.customCommands as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('preexisting');
    expect(names).toContain('veoable');
    // Other mcpServer preserved.
    expect(cfg.mcpServers['other-mcp']).toEqual({ command: 'x', args: [] });
    expect(cfg.mcpServers.veoable).toBeTruthy();
  });

  it('is idempotent — re-running replaces the veoable command, not appends a duplicate', () => {
    installContinueSkill({ continueDir: tmpRoot, db: path.join(tmpRoot, 'first.db') });
    installContinueSkill({ continueDir: tmpRoot, db: path.join(tmpRoot, 'second.db') });

    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'config.json'), 'utf-8'),
    );
    const adorableCmds = (cfg.customCommands as Array<{ name: string }>).filter(
      (c) => c.name === 'veoable',
    );
    expect(adorableCmds).toHaveLength(1);
    expect(cfg.mcpServers.veoable.args).toEqual([
      'serve',
      path.join(tmpRoot, 'second.db'),
    ]);
  });

  it('honors $CONTINUE_GLOBAL_DIR when continueDir is omitted', () => {
    const envDir = path.join(tmpRoot, 'env-continue');
    fs.mkdirSync(envDir);
    const result = installContinueSkill({
      env: { CONTINUE_GLOBAL_DIR: envDir },
    });
    expect(result.filesWritten[0]).toBe(path.join(envDir, 'config.json'));
    expect(fs.existsSync(path.join(envDir, 'config.json'))).toBe(true);
  });

  it('falls back to $HOME/.continue when no overrides given', () => {
    const fakeHome = path.join(tmpRoot, 'fake-home');
    fs.mkdirSync(fakeHome);
    const result = installContinueSkill({ env: { HOME: fakeHome } });
    expect(result.filesWritten[0]).toBe(path.join(fakeHome, '.continue', 'config.json'));
  });

  it('overwrites a malformed config.json with a fresh valid one', () => {
    // Simulate a corrupted config the user couldn't recover. The
    // tolerant reader returns {} on parse fail, so the install
    // should still produce a valid file rather than throwing.
    fs.writeFileSync(
      path.join(tmpRoot, 'config.json'),
      'not valid json {{{ \n',
      'utf-8',
    );
    installContinueSkill({ continueDir: tmpRoot });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'config.json'), 'utf-8'),
    );
    expect(Array.isArray(cfg.customCommands)).toBe(true);
    expect(cfg.customCommands[0].name).toBe('veoable');
  });
});

describe('installVSCodeSkill (#363)', () => {
  it('creates .github/copilot-instructions.md when none exists, with delimited Veoable section', () => {
    const result = installVSCodeSkill({ projectDir: tmpRoot });
    expect(result.client).toBe('vscode');
    // Without --db, only the instructions file is written.
    expect(result.filesWritten).toHaveLength(1);

    const instructionsPath = path.join(tmpRoot, '.github', 'copilot-instructions.md');
    expect(result.filesWritten[0]).toBe(instructionsPath);
    expect(fs.existsSync(instructionsPath)).toBe(true);

    const content = fs.readFileSync(instructionsPath, 'utf-8');
    // Marker pair present.
    expect(content).toContain('<!-- veoable:start v=1 (managed by `veoable install vscode`) -->');
    expect(content).toContain('<!-- veoable:end -->');
    // Routing signals + tool-usage section present.
    expect(content).toContain('Use Veoable tools FIRST');
    expect(content).toContain('Do NOT invoke Veoable for');
    expect(content).toContain('describe_skill');
  });

  it('preserves existing copilot-instructions.md content and appends the Veoable section', () => {
    const instructionsPath = path.join(tmpRoot, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
    const existingBody = '# My Project\n\nUse TypeScript strict mode.\nPrefer pnpm.\n';
    fs.writeFileSync(instructionsPath, existingBody, 'utf-8');

    installVSCodeSkill({ projectDir: tmpRoot });

    const merged = fs.readFileSync(instructionsPath, 'utf-8');
    // Existing content survives verbatim.
    expect(merged.startsWith(existingBody.trimEnd())).toBe(true);
    // Veoable section appended after.
    expect(merged).toContain('<!-- veoable:start');
    expect(merged).toContain('## Veoable — End-to-End Flow Analysis');
    expect(merged).toContain('<!-- veoable:end -->');
  });

  it('idempotent — re-running replaces the delimited region in place, not appending duplicates', () => {
    installVSCodeSkill({ projectDir: tmpRoot });
    const instructionsPath = path.join(tmpRoot, '.github', 'copilot-instructions.md');
    // Hand-insert content INSIDE the markers (a corrupted/stale
    // section the user couldn't recover).
    const v1 = fs.readFileSync(instructionsPath, 'utf-8');
    const tampered = v1.replace(
      /<!-- veoable:start[\s\S]*?<!-- veoable:end -->/,
      '<!-- veoable:start v=1 (managed by `veoable install vscode`) -->\nstale content\n<!-- veoable:end -->',
    );
    fs.writeFileSync(instructionsPath, tampered, 'utf-8');

    installVSCodeSkill({ projectDir: tmpRoot });
    const v2 = fs.readFileSync(instructionsPath, 'utf-8');

    // Marker pair appears exactly once, and the stale content is gone.
    expect(v2.match(/<!-- veoable:start/g) ?? []).toHaveLength(1);
    expect(v2.match(/<!-- veoable:end -->/g) ?? []).toHaveLength(1);
    expect(v2).not.toContain('stale content');
    expect(v2).toContain('Use Veoable tools FIRST');
  });

  it('preserves content BEFORE and AFTER the marker block on re-run', () => {
    const instructionsPath = path.join(tmpRoot, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
    // Pre-existing content with our markers embedded in the middle.
    const body = [
      '# Project',
      '',
      'Top-level guidance.',
      '',
      '<!-- veoable:start v=1 (managed by `veoable install vscode`) -->',
      'stale veoable section',
      '<!-- veoable:end -->',
      '',
      '## Other policies',
      '',
      'Always run tests.',
      '',
    ].join('\n');
    fs.writeFileSync(instructionsPath, body, 'utf-8');

    installVSCodeSkill({ projectDir: tmpRoot });
    const after = fs.readFileSync(instructionsPath, 'utf-8');

    // Everything before the markers preserved.
    expect(after).toContain('# Project');
    expect(after).toContain('Top-level guidance.');
    // Everything after the markers preserved.
    expect(after).toContain('## Other policies');
    expect(after).toContain('Always run tests.');
    // The stale section is gone.
    expect(after).not.toContain('stale veoable section');
    // Fresh content lives between the markers.
    expect(after).toContain('Use Veoable tools FIRST');
  });

  it('collapses two stale marker pairs to a single canonical section on re-run', () => {
    // A previous half-broken install (or a copy-paste bug) left TWO
    // marker pairs in the file. We expect the upsert to replace the
    // first with our canonical section AND strip the second so the
    // file ends with exactly one Veoable section.
    const instructionsPath = path.join(tmpRoot, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
    const body = [
      '# Project',
      '',
      '<!-- veoable:start v=1 (managed by `veoable install vscode`) -->',
      'first stale section',
      '<!-- veoable:end -->',
      '',
      'Middle content.',
      '',
      '<!-- veoable:start v=1 (managed by `veoable install vscode`) -->',
      'second stale section',
      '<!-- veoable:end -->',
      '',
      '## Trailing policy',
      '',
    ].join('\n');
    fs.writeFileSync(instructionsPath, body, 'utf-8');

    installVSCodeSkill({ projectDir: tmpRoot });
    const after = fs.readFileSync(instructionsPath, 'utf-8');

    // Exactly one marker pair survives.
    expect(after.match(/<!-- veoable:start/g) ?? []).toHaveLength(1);
    expect(after.match(/<!-- veoable:end -->/g) ?? []).toHaveLength(1);
    // Both stale bodies are gone.
    expect(after).not.toContain('first stale section');
    expect(after).not.toContain('second stale section');
    // Non-Veoable content survives in its original position.
    expect(after).toContain('# Project');
    expect(after).toContain('Middle content.');
    expect(after).toContain('## Trailing policy');
    // Current section content lives in the surviving block.
    expect(after).toContain('Use Veoable tools FIRST');
  });

  it('without --db, no .vscode/mcp.json is written; nextSteps points at re-run with --db', () => {
    const { filesWritten, nextSteps } = installVSCodeSkill({ projectDir: tmpRoot });
    expect(filesWritten.some((f) => f.endsWith('mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, '.vscode', 'mcp.json'))).toBe(false);
    expect(nextSteps.join('\n')).toContain('veoable install vscode --db');
  });

  it('with --db, .vscode/mcp.json gets a servers.veoable entry with type stdio', () => {
    const dbAbs = path.join(tmpRoot, 'graph.db');
    installVSCodeSkill({ projectDir: tmpRoot, db: dbAbs });

    const mcpPath = path.join(tmpRoot, '.vscode', 'mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(cfg.servers.veoable).toEqual({
      type: 'stdio',
      command: 'veoable',
      args: ['serve', dbAbs],
    });
  });

  it('resolves a relative --db against projectDir, not cwd', () => {
    installVSCodeSkill({ projectDir: tmpRoot, db: 'p.db' });
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.vscode', 'mcp.json'), 'utf-8'),
    );
    expect(cfg.servers.veoable.args).toEqual(['serve', path.join(tmpRoot, 'p.db')]);
  });

  it('merges with existing mcp.json, preserving other servers and top-level keys', () => {
    fs.mkdirSync(path.join(tmpRoot, '.vscode'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.vscode', 'mcp.json'),
      JSON.stringify({
        inputs: ['something'],
        servers: {
          'other-server': { type: 'stdio', command: 'x', args: ['run'] },
        },
      }, null, 2),
      'utf-8',
    );

    installVSCodeSkill({ projectDir: tmpRoot, db: path.join(tmpRoot, 'g.db') });

    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.vscode', 'mcp.json'), 'utf-8'),
    );
    expect(cfg.inputs).toEqual(['something']);
    expect(cfg.servers['other-server']).toEqual({
      type: 'stdio',
      command: 'x',
      args: ['run'],
    });
    expect(cfg.servers.veoable.command).toBe('veoable');
  });
});

describe('installAuto (#363)', () => {
  it('skips every client when none are detected', () => {
    // No ~/.claude, no .cursor/ in projectDir, no ~/.continue.
    const fakeHome = path.join(tmpRoot, 'home');
    fs.mkdirSync(fakeHome);
    const proj = path.join(tmpRoot, 'project');
    fs.mkdirSync(proj);

    const { installed, skipped, failed } = installAuto({
      projectDir: proj,
      env: { HOME: fakeHome },
    });
    expect(installed).toEqual([]);
    expect(failed).toEqual([]);
    expect(skipped.map((s) => s.client).sort()).toEqual([
      'claude-code',
      'continue',
      'cursor',
      'vscode',
    ]);
  });

  it('best-effort: one adapter throwing does not stop the rest', () => {
    // Make claude-code detection succeed but the install fail by
    // pointing it at a directory we'll lose write permission to.
    // Simpler: pre-create a regular FILE where SKILL.md would land,
    // so mkdirSync throws ENOTDIR.
    const fakeHome = path.join(tmpRoot, 'home');
    fs.mkdirSync(path.join(fakeHome, '.continue'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    // Block the claude-code skill dir creation with a file in the way.
    fs.writeFileSync(
      path.join(fakeHome, '.claude', 'skills'),
      'not a directory\n',
      'utf-8',
    );
    const proj = path.join(tmpRoot, 'project');
    fs.mkdirSync(proj);

    const { installed, skipped, failed } = installAuto({
      projectDir: proj,
      env: { HOME: fakeHome },
    });
    // claude-code failed because skills/ is a file, not a dir.
    expect(failed.map((f) => f.client)).toEqual(['claude-code']);
    // continue still ran successfully despite claude-code's failure.
    expect(installed.map((r) => r.client)).toContain('continue');
    expect(fs.existsSync(
      path.join(fakeHome, '.continue', 'config.json'),
    )).toBe(true);
    // cursor still got skipped (no .cursor/ in proj).
    expect(skipped.map((s) => s.client)).toContain('cursor');
  });

  it('installs only the detected clients (claude-code + continue, no cursor)', () => {
    const fakeHome = path.join(tmpRoot, 'home');
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.continue'), { recursive: true });
    const proj = path.join(tmpRoot, 'project');
    fs.mkdirSync(proj);
    // No .cursor/ in proj → cursor skipped.

    const { installed, skipped } = installAuto({
      projectDir: proj,
      env: { HOME: fakeHome },
    });

    const installedClients = installed.map((r) => r.client).sort();
    expect(installedClients).toEqual(['claude-code', 'continue']);
    expect(skipped.map((s) => s.client).sort()).toEqual(['cursor', 'vscode']);

    // Actual on-disk artifacts.
    expect(fs.existsSync(
      path.join(fakeHome, '.claude', 'skills', 'veoable', 'SKILL.md'),
    )).toBe(true);
    expect(fs.existsSync(
      path.join(fakeHome, '.continue', 'config.json'),
    )).toBe(true);
    expect(fs.existsSync(path.join(proj, '.cursor'))).toBe(false);
  });

  it('honors --db across every detected client', () => {
    const fakeHome = path.join(tmpRoot, 'home');
    fs.mkdirSync(path.join(fakeHome, '.continue'), { recursive: true });
    const proj = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(proj, '.cursor'), { recursive: true });

    const dbAbs = path.join(tmpRoot, 'g.db');
    installAuto({
      projectDir: proj,
      env: { HOME: fakeHome },
      db: dbAbs,
    });

    // Continue's config.json got the mcpServers entry.
    const continueCfg = JSON.parse(fs.readFileSync(
      path.join(fakeHome, '.continue', 'config.json'),
      'utf-8',
    ));
    expect(continueCfg.mcpServers.veoable).toEqual({
      command: 'veoable',
      args: ['serve', dbAbs],
    });
    // Cursor's mcp.json got the same entry.
    const cursorCfg = JSON.parse(fs.readFileSync(
      path.join(proj, '.cursor', 'mcp.json'),
      'utf-8',
    ));
    expect(cursorCfg.mcpServers.veoable).toEqual({
      command: 'veoable',
      args: ['serve', dbAbs],
    });
  });

  it('cursor detection respects projectDir, not cwd', () => {
    // Even if cwd has .cursor/, --auto should look in projectDir.
    const fakeHome = path.join(tmpRoot, 'home');
    fs.mkdirSync(fakeHome);
    const projWithCursor = path.join(tmpRoot, 'with-cursor');
    fs.mkdirSync(path.join(projWithCursor, '.cursor'), { recursive: true });
    const projWithout = path.join(tmpRoot, 'without-cursor');
    fs.mkdirSync(projWithout);

    const withCursor = installAuto({
      projectDir: projWithCursor,
      env: { HOME: fakeHome },
    });
    expect(withCursor.installed.map((r) => r.client)).toContain('cursor');

    const withoutCursor = installAuto({
      projectDir: projWithout,
      env: { HOME: fakeHome },
    });
    expect(withoutCursor.installed.map((r) => r.client)).not.toContain('cursor');
  });

  it('honors $CLAUDE_CONFIG_DIR + $CONTINUE_GLOBAL_DIR in detection', () => {
    const altClaude = path.join(tmpRoot, 'alt-claude');
    const altContinue = path.join(tmpRoot, 'alt-continue');
    fs.mkdirSync(altClaude);
    fs.mkdirSync(altContinue);
    const proj = path.join(tmpRoot, 'project');
    fs.mkdirSync(proj);

    const { installed } = installAuto({
      projectDir: proj,
      env: {
        // No HOME — the env-var paths must drive detection.
        CLAUDE_CONFIG_DIR: altClaude,
        CONTINUE_GLOBAL_DIR: altContinue,
      },
    });
    expect(installed.map((r) => r.client).sort()).toEqual([
      'claude-code',
      'continue',
    ]);
  });
});
