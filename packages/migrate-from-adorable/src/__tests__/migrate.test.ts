/**
 * Unit tests for the migration transforms. Each transform runs against
 * a small text fixture; we assert the returned changes AND the emitted
 * text so a regression in either surface is caught.
 *
 * File I/O paths get their own end-to-end test that uses os.tmpdir()
 * so package.json / .mcp.json parsing runs against real files. Kept
 * separate from the unit tests to avoid slowing the common case.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatChangesSummary,
  makeOptions,
  migrateFile,
  migrateMcpConfigText,
  migratePackageJsonText,
  migrateProject,
  rewriteCliUsageInText,
  rewriteScopeInText,
} from '../index.js';

describe('rewriteScopeInText', () => {
  it('rewrites @adorable/ → @veoable/ across every occurrence on a line', () => {
    const before = `import { foo } from '@adorable/foo';\nimport { bar } from '@adorable/bar';`;
    const { updated, changes } = rewriteScopeInText('x.ts', before, 'import-rewrite');
    expect(updated).toBe(`import { foo } from '@veoable/foo';\nimport { bar } from '@veoable/bar';`);
    expect(changes).toHaveLength(2);
    expect(changes[0]!.line).toBe(1);
    expect(changes[1]!.line).toBe(2);
  });

  it('handles multiple @adorable references on a single line', () => {
    // Rare but happens in barrel re-exports: `export * from '@adorable/a'; export * from '@adorable/b';`
    const before = `import a from '@adorable/a'; import b from '@adorable/b';`;
    const { updated, changes } = rewriteScopeInText('x.ts', before, 'import-rewrite');
    expect(updated).toBe(`import a from '@veoable/a'; import b from '@veoable/b';`);
    // Only one changed *line* — we report by line, not by occurrence
    expect(changes).toHaveLength(1);
    expect(changes[0]!.line).toBe(1);
  });

  it('is a no-op when the file has no adorable references', () => {
    const before = `import { foo } from 'external-lib';`;
    const { updated, changes } = rewriteScopeInText('x.ts', before, 'import-rewrite');
    expect(updated).toBe(before);
    expect(changes).toHaveLength(0);
  });
});

describe('rewriteCliUsageInText', () => {
  it('rewrites adorable <subcommand> patterns', () => {
    const before = `Run \`adorable analyze .\` to build a graph.`;
    const { updated, changes } = rewriteCliUsageInText('x.md', before);
    expect(updated).toBe(`Run \`veoable analyze .\` to build a graph.`);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('cli-usage-string');
  });

  it('leaves historical URLs untouched', () => {
    // These URLs would break if we rewrote them — they still resolve
    // to the old repo.
    const before = `See https://github.com/mudit70/adorable/blob/main/docs/userguide.md`;
    const { updated, changes } = rewriteCliUsageInText('x.md', before);
    expect(updated).toBe(before);
    expect(changes).toHaveLength(0);
  });

  it('leaves the bare word "adorable" alone (no subcommand context)', () => {
    // People still write about the old project by name; don't rewrite
    // prose mentions like "originally shipped as adorable".
    const before = `Originally shipped as adorable, this project is now veoable.`;
    const { updated, changes } = rewriteCliUsageInText('x.md', before);
    expect(updated).toBe(before);
    expect(changes).toHaveLength(0);
  });
});

describe('migratePackageJsonText', () => {
  it('rewrites dependency records', () => {
    const before = JSON.stringify(
      {
        name: 'my-app',
        dependencies: {
          '@adorable/cli': 'workspace:*',
          '@adorable/mcp-server': '^0.3.0',
          'chokidar': '^4.0.0',
        },
      },
      null,
      2,
    );
    const { updated, changes } = migratePackageJsonText('package.json', before);
    const parsed = JSON.parse(updated);
    expect(parsed.dependencies).toEqual({
      '@veoable/cli': 'workspace:*',
      '@veoable/mcp-server': '^0.3.0',
      'chokidar': '^4.0.0',
    });
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.kind === 'package-json-dep')).toBe(true);
  });

  it('rewrites bin.adorable', () => {
    const before = JSON.stringify({ bin: { adorable: './dist/cli.js' } }, null, 2);
    const { updated, changes } = migratePackageJsonText('package.json', before);
    const parsed = JSON.parse(updated);
    expect(parsed.bin).toEqual({ veoable: './dist/cli.js' });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('package-json-bin');
  });

  it('rewrites scripts.adorable', () => {
    const before = JSON.stringify(
      { scripts: { adorable: 'node packages/cli/dist/cli.js' } },
      null,
      2,
    );
    const { updated, changes } = migratePackageJsonText('package.json', before);
    const parsed = JSON.parse(updated);
    expect(parsed.scripts).toEqual({ veoable: 'node packages/cli/dist/cli.js' });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('package-json-script');
  });

  it('rewrites the workspace root name if it is "adorable"', () => {
    const before = JSON.stringify({ name: 'adorable', version: '0.3.0' }, null, 2);
    const { updated, changes } = migratePackageJsonText('package.json', before);
    const parsed = JSON.parse(updated);
    expect(parsed.name).toBe('veoable');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('package-json-name');
  });

  it('is a no-op on package.json with no adorable references', () => {
    const before = JSON.stringify(
      { name: 'my-app', dependencies: { chokidar: '^4' } },
      null,
      2,
    );
    const { updated, changes } = migratePackageJsonText('package.json', before);
    expect(updated).toBe(before);
    expect(changes).toHaveLength(0);
  });

  it('handles malformed package.json gracefully', () => {
    const before = 'not json {';
    const { updated, changes } = migratePackageJsonText('package.json', before);
    expect(updated).toBe(before);
    expect(changes).toHaveLength(0);
  });
});

describe('migrateMcpConfigText', () => {
  it('renames the "adorable" mcpServers key', () => {
    const before = JSON.stringify(
      {
        mcpServers: {
          adorable: {
            command: 'node',
            args: ['packages/cli/dist/cli.js', 'serve', 'graph.db'],
          },
        },
      },
      null,
      2,
    );
    const { updated, changes } = migrateMcpConfigText('.mcp.json', before);
    const parsed = JSON.parse(updated);
    expect(parsed.mcpServers.veoable).toBeTruthy();
    expect(parsed.mcpServers.adorable).toBeUndefined();
    expect(parsed.mcpServers.veoable.command).toBe('node');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('mcp-config-key');
  });

  it('preserves other MCP servers alongside adorable', () => {
    const before = JSON.stringify(
      {
        mcpServers: {
          adorable: { command: 'node' },
          github: { command: 'gh-mcp' },
        },
      },
      null,
      2,
    );
    const { updated } = migrateMcpConfigText('.mcp.json', before);
    const parsed = JSON.parse(updated);
    expect(parsed.mcpServers.veoable).toBeTruthy();
    expect(parsed.mcpServers.github).toBeTruthy();
    expect(parsed.mcpServers.adorable).toBeUndefined();
  });

  it('is a no-op when the "adorable" key is absent', () => {
    const before = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }, null, 2);
    const { updated, changes } = migrateMcpConfigText('.mcp.json', before);
    expect(updated).toBe(before);
    expect(changes).toHaveLength(0);
  });
});

describe('formatChangesSummary', () => {
  it('reports a clean tree', () => {
    expect(formatChangesSummary([])).toContain('No @adorable/* → @veoable/* migration needed');
  });

  it('groups by kind', () => {
    const summary = formatChangesSummary([
      { file: 'a.ts', kind: 'import-rewrite', line: 1, before: 'a', after: 'b' },
      { file: 'a.ts', kind: 'import-rewrite', line: 2, before: 'a', after: 'b' },
      { file: 'package.json', kind: 'package-json-dep', line: 0, before: 'x', after: 'y' },
    ]);
    expect(summary).toContain('2 × import-rewrite');
    expect(summary).toContain('1 × package-json-dep');
    expect(summary).toContain('across 2 file(s)');
  });
});

describe('migrateFile + migrateProject (real filesystem)', () => {
  it('dry-run leaves files untouched', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-migrate-'));
    const pkg = path.join(tmp, 'package.json');
    await fs.writeFile(pkg, JSON.stringify({ dependencies: { '@adorable/cli': '^0.3.0' } }, null, 2));
    const changes = await migrateProject(makeOptions({ root: tmp, dryRun: true }));
    expect(changes).toHaveLength(1);
    const after = JSON.parse(await fs.readFile(pkg, 'utf8'));
    expect(after.dependencies['@adorable/cli']).toBe('^0.3.0'); // unchanged
    expect(after.dependencies['@veoable/cli']).toBeUndefined();
  });

  it('--apply writes changes back to disk', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-migrate-'));
    const pkg = path.join(tmp, 'package.json');
    const src = path.join(tmp, 'a.ts');
    await fs.writeFile(pkg, JSON.stringify({ dependencies: { '@adorable/cli': '^0.3.0' } }, null, 2));
    await fs.writeFile(src, `import { foo } from '@adorable/foo';\n`);
    const changes = await migrateProject(makeOptions({ root: tmp, dryRun: false }));
    expect(changes.length).toBeGreaterThanOrEqual(2);
    const afterPkg = JSON.parse(await fs.readFile(pkg, 'utf8'));
    expect(afterPkg.dependencies['@veoable/cli']).toBe('^0.3.0');
    expect(afterPkg.dependencies['@adorable/cli']).toBeUndefined();
    const afterSrc = await fs.readFile(src, 'utf8');
    expect(afterSrc).toBe(`import { foo } from '@veoable/foo';\n`);
  });

  it('rewrites .mcp.json when present', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-migrate-'));
    const mcp = path.join(tmp, '.mcp.json');
    await fs.writeFile(
      mcp,
      JSON.stringify({ mcpServers: { adorable: { command: 'node' } } }, null, 2),
    );
    await migrateProject(makeOptions({ root: tmp, dryRun: false }));
    const parsed = JSON.parse(await fs.readFile(mcp, 'utf8'));
    expect(parsed.mcpServers.veoable).toBeTruthy();
    expect(parsed.mcpServers.adorable).toBeUndefined();
  });

  it('ignores node_modules and .git', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-migrate-'));
    const nested = path.join(tmp, 'node_modules', 'foo');
    await fs.mkdir(nested, { recursive: true });
    const nodeMod = path.join(nested, 'package.json');
    await fs.writeFile(nodeMod, JSON.stringify({ dependencies: { '@adorable/cli': '*' } }));
    const changes = await migrateProject(makeOptions({ root: tmp, dryRun: false }));
    expect(changes).toHaveLength(0);
    const still = JSON.parse(await fs.readFile(nodeMod, 'utf8'));
    expect(still.dependencies['@adorable/cli']).toBe('*');
  });
});

describe('migrateFile (individual)', () => {
  it('accepts absolute file paths', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'veoable-migrate-'));
    const f = path.join(tmp, 'a.ts');
    await fs.writeFile(f, `import x from '@adorable/x';\n`);
    const changes = await migrateFile(f, makeOptions({ root: tmp, dryRun: false }));
    expect(changes).toHaveLength(1);
    const after = await fs.readFile(f, 'utf8');
    expect(after).toContain(`'@veoable/x'`);
  });
});
