#!/usr/bin/env node
/**
 * @veoable/migrate-from-adorable — CLI entry point.
 *
 * Discovers `@adorable/*` imports, package.json deps, `bin.adorable`,
 * `scripts.adorable`, and MCP configs referring to `"adorable"` inside
 * a user's project, and rewrites them to the veoable equivalents.
 *
 * Design goal: safe to run without prior review. Defaults to `--dry-run`;
 * an explicit `--apply` is required to touch disk. That keeps this
 * command from turning into a footgun when someone runs it with the
 * wrong CWD.
 */
import * as path from 'node:path';
import * as process from 'node:process';
import {
  LICENSE_NOTICE,
  formatChangesSummary,
  makeOptions,
  migrateProject,
  type MigrationChange,
} from './index.js';

interface CliArgs {
  root: string;
  apply: boolean;
  noCliUsage: boolean;
  showFiles: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    root: process.cwd(),
    apply: false,
    noCliUsage: false,
    showFiles: false,
    help: false,
  };
  let sawRoot = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        args.apply = false;
        break;
      case '--no-cli-usage':
        args.noCliUsage = true;
        break;
      case '--show-files':
        args.showFiles = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown flag: ${arg}`);
          process.exit(2);
        }
        if (sawRoot) {
          console.error(`Unexpected positional argument: ${arg}`);
          process.exit(2);
        }
        args.root = path.resolve(process.cwd(), arg);
        sawRoot = true;
    }
  }
  return args;
}

function printHelp(): void {
  const text = `
veoable-migrate-from-adorable — upgrade a project from @adorable/* to @veoable/*

USAGE
  veoable-migrate-from-adorable [path] [options]

DESCRIPTION
  Walks the given directory tree (default: current working directory)
  and rewrites:

    - Every "@adorable/xxx" import / require in .ts, .tsx, .js, .jsx,
      .mjs, .cjs, .mts, .cts files.
    - Every package.json:
        - name field if it equals "adorable"
        - dependencies / devDependencies / peerDependencies /
          optionalDependencies keys starting with "@adorable/"
        - bin.adorable → bin.veoable
        - scripts.adorable → scripts.veoable
    - Every MCP client config (mcp.json, .mcp.json,
      claude_desktop_config.json) whose mcpServers has an "adorable"
      key — the key is renamed to "veoable".
    - CLI usage in .md / .sh / .zsh / .bash files where "adorable"
      is followed by a known subcommand (analyze, serve, chat, install,
      project, tools). The match is conservative to avoid rewriting
      historical URLs.

  Defaults to dry-run mode. Pass --apply to actually touch disk.

OPTIONS
  --apply             Actually write changes. Without this, only prints.
  --dry-run           Explicit dry-run mode (default).
  --no-cli-usage      Skip rewriting CLI usage inside .md / .sh files.
  --show-files        Print every file:line change (verbose).
  -h, --help          Show this help.

EXAMPLES
  # See what would change (safe):
  npx @veoable/migrate-from-adorable

  # Apply the migration:
  npx @veoable/migrate-from-adorable --apply

  # Migrate a specific subtree without touching CLI-usage docs:
  npx @veoable/migrate-from-adorable ./services --no-cli-usage --apply

LICENSE NOTE
  ${LICENSE_NOTICE.split('\n').join('\n  ')}
`.trim();
  console.log(text);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const opts = makeOptions({
    root: args.root,
    dryRun: !args.apply,
    rewriteCliUsage: !args.noCliUsage,
  });

  console.log(
    `veoable-migrate-from-adorable · ${args.apply ? 'APPLY' : 'dry-run'} · root = ${opts.root}`,
  );

  let changes: MigrationChange[];
  try {
    changes = await migrateProject(opts);
  } catch (e) {
    console.error(`migration failed: ${(e as Error).message}`);
    process.exit(1);
  }

  const summary = formatChangesSummary(changes);
  console.log('');
  console.log(summary);

  if (args.showFiles && changes.length > 0) {
    console.log('Changes:');
    for (const c of changes) {
      const where = c.line === 0 ? c.file : `${c.file}:${c.line}`;
      console.log(`  [${c.kind}] ${where}`);
      if (c.line !== 0) {
        console.log(`      - ${c.before}`);
        console.log(`      + ${c.after}`);
      }
    }
    console.log('');
  }

  if (!args.apply && changes.length > 0) {
    console.log('Re-run with --apply to write these changes.');
  }

  console.log('');
  console.log(LICENSE_NOTICE);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
