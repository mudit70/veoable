/**
 * @veoable/migrate-from-adorable — library entry point.
 *
 * The API here is exported so the CLI can consume it AND so downstream
 * tooling (IDE extensions, higher-level codemods) can call the same
 * migration primitives programmatically without shelling out.
 *
 * Every mutation function returns a {@link MigrationChange}[] describing
 * exactly what would be done, and only applies the change when
 * `dryRun` is `false`. That contract keeps the CLI's `--dry-run` flag
 * a one-line toggle instead of a duplicate code path.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Root package name of the previous ("adorable") namespace. Kept as a
 * const so unit tests can assert on it and any future re-brand can
 * change the identifier in exactly one place.
 */
export const OLD_SCOPE = '@adorable/';

/** Root package name of the current ("veoable") namespace. */
export const NEW_SCOPE = '@veoable/';

/**
 * Old CLI binary name (bin field, install-cli scripts, `adorable <cmd>`
 * usage in user scripts).
 */
export const OLD_CLI = 'adorable';

/** New CLI binary name. */
export const NEW_CLI = 'veoable';

/**
 * MCP server identifier — the key some client configs (Claude Desktop,
 * Cursor, Continue, Zed) use to reference the server. Renamed load-
 * bearingly in mudit70/veoable#3 so we can't leave stale keys behind.
 */
export const OLD_MCP_NAME = 'adorable';
export const NEW_MCP_NAME = 'veoable';

/** Skill identifier (SKILL.md frontmatter + per-client skill adapters). */
export const OLD_SKILL_NAME = 'adorable';
export const NEW_SKILL_NAME = 'veoable';

/**
 * A single rewrite the migrator would apply. We collect these ahead of
 * writing so both dry-run reporting and actual application share the
 * same execution path. `before` / `after` are inclusive of surrounding
 * context so a UI can preview a diff hunk without re-reading the file.
 */
export interface MigrationChange {
  file: string;
  kind:
    | 'import-rewrite'
    | 'package-json-name'
    | 'package-json-dep'
    | 'package-json-bin'
    | 'package-json-script'
    | 'mcp-config-key'
    | 'cli-usage-string';
  /** Line number in the file (1-indexed). 0 means "whole-file operation". */
  line: number;
  before: string;
  after: string;
}

export interface MigrationOptions {
  /** Directory root — every discovered file lives under here. */
  root: string;
  /**
   * File extensions to consider for import + CLI-usage rewrites.
   * package.json and MCP configs are always scanned regardless.
   */
  extensions: readonly string[];
  /**
   * If true, don't touch disk — just return the changes we would have
   * made. Enables the `--dry-run` flag on the CLI.
   */
  dryRun: boolean;
  /**
   * Whether to rewrite CLI usage strings (`adorable <command>` →
   * `veoable <command>`) inside .md docs and shell scripts. Default
   * true; users who want to preserve historical references can opt
   * out.
   */
  rewriteCliUsage: boolean;
  /**
   * Glob-ish path prefixes to ignore. Sensible defaults (node_modules,
   * .git, dist, coverage) are merged in by the CLI; consumers of the
   * library are responsible for their own if they don't set this.
   */
  ignore: readonly string[];
}

const DEFAULT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
] as const;

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.parcel-cache',
] as const;

/**
 * Convenience factory — most callers only care about `root`.
 */
export function makeOptions(partial: Partial<MigrationOptions> & { root: string }): MigrationOptions {
  return {
    extensions: partial.extensions ?? DEFAULT_EXTENSIONS,
    dryRun: partial.dryRun ?? false,
    rewriteCliUsage: partial.rewriteCliUsage ?? true,
    ignore: partial.ignore ?? DEFAULT_IGNORE,
    root: partial.root,
  };
}

/**
 * Walk `root` respecting `ignore`, calling `visit` for every file whose
 * extension matches OR whose basename is one of the always-scanned
 * config filenames.
 */
async function walk(
  root: string,
  ignore: readonly string[],
  extensions: readonly string[],
  visit: (absPath: string) => Promise<void>,
): Promise<void> {
  const extSet = new Set(extensions);
  const alwaysScan = new Set([
    'package.json',
    'mcp.json',
    '.mcp.json',
    'claude_desktop_config.json',
    'settings.json',
  ]);
  async function recurse(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      // Permission errors on stray dirs shouldn't kill the migration;
      // report + skip.
      // eslint-disable-next-line no-console
      console.warn(`migrate: skipping ${dir}: ${(e as Error).message}`);
      return;
    }
    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (extSet.has(ext) || alwaysScan.has(entry.name)) {
        await visit(full);
      }
    }
  }
  await recurse(root);
}

/**
 * Rewrite `@adorable/*` → `@veoable/*` in any file content. Used for
 * both source imports and package.json dependency records — the same
 * literal substring works for both, and returning the changes with a
 * line number lets the CLI print an accurate report.
 */
export function rewriteScopeInText(
  file: string,
  text: string,
  kind: MigrationChange['kind'],
): { updated: string; changes: MigrationChange[] } {
  const lines = text.split('\n');
  const changes: MigrationChange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const before = lines[i]!;
    if (!before.includes(OLD_SCOPE)) continue;
    const after = before.split(OLD_SCOPE).join(NEW_SCOPE);
    if (after !== before) {
      changes.push({ file, kind, line: i + 1, before, after });
      lines[i] = after;
    }
  }
  return { updated: lines.join('\n'), changes };
}

/**
 * Rewrite `adorable ...` CLI usage strings inside prose / shell files.
 * Careful — we only touch word-boundary lowercase `adorable`, and only
 * when followed by a space + a plausible subcommand character. That
 * avoids matching `mudit70/adorable` URLs, fixture strings like
 * `?q=adorable`, and other non-CLI mentions.
 */
export function rewriteCliUsageInText(
  file: string,
  text: string,
): { updated: string; changes: MigrationChange[] } {
  const cliPattern = /\badorable(?=\s+(?:analyze|serve|chat|install|project|tools|--)\b)/g;
  const lines = text.split('\n');
  const changes: MigrationChange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const before = lines[i]!;
    if (!cliPattern.test(before)) continue;
    // Reset lastIndex since we `test`ed above; replace uses its own
    // internal iteration.
    cliPattern.lastIndex = 0;
    const after = before.replace(cliPattern, NEW_CLI);
    if (after !== before) {
      changes.push({ file, kind: 'cli-usage-string', line: i + 1, before, after });
      lines[i] = after;
    }
  }
  return { updated: lines.join('\n'), changes };
}

/**
 * Package.json is the highest-signal file to rewrite. We parse it,
 * mutate specific fields, then re-serialize with 2-space indentation
 * to match the pnpm ecosystem convention. Preserving arbitrary
 * formatting isn't worth the complexity — users can `pnpm format`
 * afterwards.
 */
export function migratePackageJsonText(
  file: string,
  text: string,
): { updated: string; changes: MigrationChange[] } {
  const changes: MigrationChange[] = [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Skip malformed package.json files rather than blow up the run.
    return { updated: text, changes };
  }
  // 1) top-level name — only relevant if the user's workspace was
  // itself named `adorable` (uncommon but possible).
  if (parsed['name'] === OLD_CLI) {
    changes.push({
      file,
      kind: 'package-json-name',
      line: 0,
      before: `"name": "${OLD_CLI}"`,
      after: `"name": "${NEW_CLI}"`,
    });
    parsed['name'] = NEW_CLI;
  }
  // 2) dependency records — @adorable/* keys get renamed to @veoable/*.
  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const deps = parsed[depField];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    const entries = Object.entries(deps as Record<string, string>);
    let touched = false;
    const next: Record<string, string> = {};
    for (const [name, version] of entries) {
      if (name.startsWith(OLD_SCOPE)) {
        const renamed = NEW_SCOPE + name.slice(OLD_SCOPE.length);
        changes.push({
          file,
          kind: 'package-json-dep',
          line: 0,
          before: `"${name}": "${version}"`,
          after: `"${renamed}": "${version}"`,
        });
        next[renamed] = version;
        touched = true;
      } else {
        next[name] = version;
      }
    }
    if (touched) {
      (parsed as Record<string, unknown>)[depField] = next;
    }
  }
  // 3) bin field — if it maps `adorable` → …, rewrite the key.
  const bin = parsed['bin'];
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const b = bin as Record<string, string>;
    if (OLD_CLI in b) {
      const target = b[OLD_CLI]!;
      changes.push({
        file,
        kind: 'package-json-bin',
        line: 0,
        before: `"${OLD_CLI}": "${target}"`,
        after: `"${NEW_CLI}": "${target}"`,
      });
      delete b[OLD_CLI];
      b[NEW_CLI] = target;
    }
  }
  // 4) scripts.adorable convention — some users have
  // `"adorable": "node ..."` as a workspace shortcut.
  const scripts = parsed['scripts'];
  if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    const s = scripts as Record<string, string>;
    if (OLD_CLI in s) {
      const cmd = s[OLD_CLI]!;
      changes.push({
        file,
        kind: 'package-json-script',
        line: 0,
        before: `"${OLD_CLI}": ${JSON.stringify(cmd)}`,
        after: `"${NEW_CLI}": ${JSON.stringify(cmd)}`,
      });
      delete s[OLD_CLI];
      s[NEW_CLI] = cmd;
    }
  }
  if (changes.length === 0) {
    return { updated: text, changes };
  }
  const updated = JSON.stringify(parsed, null, 2) + (text.endsWith('\n') ? '\n' : '');
  return { updated, changes };
}

/**
 * MCP client configs (Claude Desktop, Cursor, Continue, Zed) typically
 * take shape:
 * {
 *   "mcpServers": {
 *     "adorable": { "command": "...", "args": [...] }
 *   }
 * }
 *
 * We rewrite the server key when it matches OLD_MCP_NAME, leaving
 * everything else (command, args, env) untouched. Users with multiple
 * MCP servers keep the rest of their config intact.
 */
export function migrateMcpConfigText(
  file: string,
  text: string,
): { updated: string; changes: MigrationChange[] } {
  const changes: MigrationChange[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { updated: text, changes };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { updated: text, changes };
  }
  const root = parsed as Record<string, unknown>;
  const servers = root['mcpServers'];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { updated: text, changes };
  }
  const s = servers as Record<string, unknown>;
  if (OLD_MCP_NAME in s) {
    const cfg = s[OLD_MCP_NAME];
    changes.push({
      file,
      kind: 'mcp-config-key',
      line: 0,
      before: `"${OLD_MCP_NAME}": <mcp server entry>`,
      after: `"${NEW_MCP_NAME}": <mcp server entry>`,
    });
    delete s[OLD_MCP_NAME];
    s[NEW_MCP_NAME] = cfg;
  }
  if (changes.length === 0) {
    return { updated: text, changes };
  }
  const updated = JSON.stringify(parsed, null, 2) + (text.endsWith('\n') ? '\n' : '');
  return { updated, changes };
}

/**
 * Migrate a single file. Chooses the right transform by filename +
 * extension. Returns the changes it would apply; only writes to disk
 * when `!opts.dryRun`.
 */
export async function migrateFile(
  absPath: string,
  opts: MigrationOptions,
): Promise<MigrationChange[]> {
  const basename = path.basename(absPath);
  const text = await fs.readFile(absPath, 'utf8');
  let updated = text;
  const changes: MigrationChange[] = [];

  if (basename === 'package.json') {
    const r = migratePackageJsonText(absPath, updated);
    updated = r.updated;
    changes.push(...r.changes);
  } else if (basename === '.mcp.json' || basename === 'mcp.json' || basename === 'claude_desktop_config.json') {
    const r = migrateMcpConfigText(absPath, updated);
    updated = r.updated;
    changes.push(...r.changes);
  } else {
    // Source / config file — rewrite @adorable/* everywhere.
    const scopeResult = rewriteScopeInText(absPath, updated, 'import-rewrite');
    updated = scopeResult.updated;
    changes.push(...scopeResult.changes);
    // Optional CLI-usage rewrite for .md / .sh / .zsh files.
    if (opts.rewriteCliUsage) {
      const ext = path.extname(basename);
      if (ext === '.md' || ext === '.sh' || ext === '.zsh' || ext === '.bash') {
        const cliResult = rewriteCliUsageInText(absPath, updated);
        updated = cliResult.updated;
        changes.push(...cliResult.changes);
      }
    }
  }

  if (changes.length > 0 && !opts.dryRun && updated !== text) {
    await fs.writeFile(absPath, updated, 'utf8');
  }
  return changes;
}

/**
 * Migrate an entire project. Returns every change; call sites decide
 * how to render (CLI prints a table, IDE surfaces a preview panel).
 */
export async function migrateProject(opts: MigrationOptions): Promise<MigrationChange[]> {
  const changes: MigrationChange[] = [];
  await walk(opts.root, opts.ignore, opts.extensions, async (file) => {
    const fileChanges = await migrateFile(file, opts);
    changes.push(...fileChanges);
  });
  return changes;
}

/**
 * Human-readable summary of what a migration touched. Grouped by kind
 * so the report is scannable in a terminal.
 */
export function formatChangesSummary(changes: readonly MigrationChange[]): string {
  if (changes.length === 0) {
    return 'No @adorable/* → @veoable/* migration needed.\n';
  }
  const byKind = new Map<MigrationChange['kind'], number>();
  const files = new Set<string>();
  for (const c of changes) {
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    files.add(c.file);
  }
  const lines: string[] = [];
  lines.push(`Migrated ${changes.length} occurrence(s) across ${files.size} file(s):`);
  for (const [kind, count] of byKind.entries()) {
    lines.push(`  ${count.toString().padStart(4)} × ${kind}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Explicit notice about the license shift users will inherit when
 * they upgrade from @adorable/* to @veoable/*. Printed once at the
 * end of a run. Reference:
 * - mudit70/adorable is MIT.
 * - mudit70/veoable is Apache-2.0 (decided 2026-06-30 during OSS
 *   readiness review; recorded in the veoable CHANGELOG).
 */
export const LICENSE_NOTICE = `
Note: mudit70/adorable was released under the MIT License, while
mudit70/veoable is released under Apache-2.0. Both are permissive and
compatible with each other and with common downstream licenses. See
https://github.com/mudit70/veoable/blob/main/LICENSE for the full text.
`.trim();
