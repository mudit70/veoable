import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyze } from './analyze.js';
import {
  discoverManifests,
  discoverWorkspacePackages,
  synthesizeWorkspaceCompilerPaths,
} from './discover.js';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { makeBatchMeta } from '@veoable/plugin-api';
import type { ResolvesToEndpointEdge } from '@veoable/schema';
import {
  discoverProxyRules,
  buildApplicationScope,
  type Application,
  type ProxyRule,
} from '@veoable/flow-stitcher';
import {
  findCanonicalPrismaSchemas,
  PRISMA_PLUGIN_ID,
} from '@veoable/framework-prisma';

/**
 * Project config file schema.
 *
 * Stitch rules are ONLY applied when explicitly added by a human to
 * the project config. The pipeline suggests rules automatically but
 * never applies them without human approval.
 */
export interface ProjectConfig {
  name: string;
  output: string;
  repos: Array<{
    path: string;
    name: string;
  }>;
  stitchMode?: 'none' | 'auto-exact' | 'auto-all';
  /** Human-approved URL transformation rules applied during stitching. */
  stitchRules?: StitchRule[];
  /**
   * Application-pair scoping (#255). Declare which repos belong to
   * the same application; the stitcher restricts caller→endpoint
   * matches to repos that share at least one application. Useful for
   * monorepos with multiple independent apps (e.g., a mobile client +
   * its backend, separate from an admin web app + its backend) that
   * happen to share URL paths.
   *
   * Default (omitted or empty) — every repo stitches to every other,
   * preserving v1 behavior.
   */
  applications?: Application[];
}

export interface StitchRule {
  name: string;
  from: string;
  to: string;
  transform: {
    stripPrefix?: string;
    addPrefix?: string;
    replacePrefix?: { from: string; to: string };
  };
}

/**
 * Run `adorable project analyze` — analyze all repos in a project
 * config file into a single database.
 *
 * After analysis:
 * 1. Apply any human-approved stitch rules from the config
 * 2. Detect prefix mismatches and SUGGEST (not apply) new rules
 */
export async function analyzeProject(
  configPath: string,
  opts: {
    verbose?: boolean;
    fresh?: boolean;
    /**
     * #294 Phase 2a — incremental mode. When true, each per-repo
     * `analyze` call uses the `source_file_hashes` sidecar table to
     * skip files that haven't changed since the last run. See
     * `analyze.ts` for the algorithm + schema-version fallback.
     * Mutually exclusive with `fresh`.
     */
    incremental?: boolean;
    /**
     * #294 Phase 1 — watch-mode re-analysis. When provided, only the
     * named repos run the per-repo `analyze` step; everything else
     * (setup, post-analysis finalizers, cross-repo stitching) still
     * runs over the full config so the graph remains coherent. Names
     * not present in the project config are silently skipped to keep
     * the watch loop resilient to renamed/removed repos.
     *
     * Distinguishing cases:
     *  - `undefined` (the default) — every repo is analyzed; this is
     *    the legacy `project analyze` path.
     *  - `[]` (empty array) — NO repo is re-analyzed; only the
     *    post-analysis finalizers + stitching run. Useful for
     *    rebuilding stitch state after an edit that didn't change
     *    any source file (rare).
     *
     * Cross-repo finalizer caveat: `mergeAliasedDatabaseTables` and
     * `pruneEmptyDatabaseSystems` operate globally — a partial re-run
     * still re-evaluates them across the whole DB. If two repos share
     * the same `DatabaseSystem`, an inferred table emitted by the
     * unchanged repo may alias-merge into a canonical owned by the
     * refreshed repo, since both are visible at finalizer time. This
     * is correct behavior under normal operation (node ids are
     * content-addressed and stable across cycles) but worth a
     * follow-up if real-world watch usage surfaces edge cases.
     */
    onlyRepos?: readonly string[];
    /**
     * Per-repo progress hooks. Watch mode wires these up to give
     * users a `[2/11] Refreshing alpha…` style indicator so a 30s
     * cycle isn't a black box. Standalone `project analyze` leaves
     * them undefined for the legacy quiet-by-default behavior;
     * `--verbose` users still get the existing `── Analyzing X ──`
     * banner from `log`.
     */
    onRepoStart?: (info: { name: string; index: number; total: number }) => void;
    onRepoEnd?: (info: { name: string; index: number; total: number; elapsedMs: number }) => void;
  } = {}
): Promise<void> {
  const log = opts.verbose ? (msg: string) => console.error(msg) : () => {};

  const absConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absConfigPath);
  // #345 — resolve the OUTER workspace root by walking up from
  // configDir looking for monorepo markers. When the project config
  // lives at a non-canonical location (e.g. `myrepo/configs/foo.project.json`)
  // configDir misses real workspace metadata one level up. Falls back
  // to configDir when no marker is found (single-repo or unconventional layout).
  const workspaceRoot = findWorkspaceRoot(configDir);
  let config: ProjectConfig;
  try {
    config = JSON.parse(fs.readFileSync(absConfigPath, 'utf-8')) as ProjectConfig;
  } catch (err) {
    throw new Error(`Failed to read project config: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!config.repos || config.repos.length === 0) {
    throw new Error('Project config has no repos');
  }

  const outputPath = path.resolve(configDir, config.output);
  log(`Project: ${config.name}`);
  log(`Output: ${outputPath}`);
  log(`Repos: ${config.repos.length}`);

  // Fresh: delete existing db and WAL files.
  if (opts.fresh) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(outputPath + suffix); } catch { /* ignore */ }
    }
    log(`Deleted ${config.output} (fresh start)`);
    // --fresh wins over --incremental. With no DB on disk there are
    // no stored hashes anyway, but explicitly clearing the flag also
    // skips the hash-diff bookkeeping path in analyze().
    opts.incremental = false;
  }

  // Aggregate proxy rules from every repo so cross-repo stitching
  // (frontend's Vite proxy → backend's endpoints) works in the
  // per-repo stitch pass and the final re-stitch (#188).
  const allProxyRules: ProxyRule[] = [];
  for (const repo of config.repos) {
    const repoPath = path.resolve(configDir, repo.path);
    const rules = discoverProxyRules(repoPath);
    if (rules.length > 0) {
      log(`Discovered ${rules.length} proxy rule(s) in ${repo.name}`);
      allProxyRules.push(...rules);
    }
  }

  // #255 — build the application-scope filter once. The stitcher uses
  // it to suppress cross-application matches (e.g., RN client → admin
  // backend) in monorepos where those apps share URL paths.
  const applicationScope =
    config.applications && config.applications.length > 0
      ? buildApplicationScope(config.applications)
      : undefined;
  if (applicationScope) {
    log(`Applications: ${config.applications!.map((a) => a.name).join(', ')}`);
  }

  // Persist the applications declaration into the store so MCP tools
  // (which see only the SQLite, not the project config file) can
  // re-apply the scope on subsequent stitch / auto_stitch calls. Without
  // this, those tools would silently re-introduce the cross-app edges
  // the CLI just suppressed.
  if (config.applications && config.applications.length > 0) {
    const persistStore = new SQLiteCanonicalGraphStore(outputPath);
    try {
      persistStore.setMeta('applications', JSON.stringify(config.applications));
    } finally {
      persistStore.close();
    }
  }

  // #325 — discover workspace packages at the project's parent
  // directory (the typical monorepo root). When per-repo analyses
  // run, each repo's `rootDir` doesn't see the workspace declaration
  // sitting at the parent level, so cross-package imports like
  // `@dub/prisma` from `apps/web/` to `packages/prisma/` previously
  // failed to resolve. We synthesize once at the project level and
  // pass the same path map into every per-repo analyze call.
  const projectManifests = discoverManifests(workspaceRoot);
  const projectWorkspacePackages = discoverWorkspacePackages(workspaceRoot, projectManifests);
  const projectCompilerPaths = synthesizeWorkspaceCompilerPaths(workspaceRoot, projectWorkspacePackages);
  if (projectWorkspacePackages.length > 0) {
    log(`Synthesized ${Object.keys(projectCompilerPaths).length / 2} workspace path mapping(s) from ${workspaceRoot}`);
  }

  // #344 — One-time workspace scan for framework-specific resources.
  // Without this, every per-repo plugin instance independently
  // re-walks the workspace tree on its `appliesTo` / `onProjectLoaded`
  // fallback path. We do the scan once here and thread the result
  // through `analyze()` → `ProjectContext.frameworkDiscoveries` so
  // all per-repo plugins reuse it.
  //
  // Currently only `PrismaPlugin` consumes a pre-discovery channel
  // (canonical schemas under `workspaceRoot`, bounded depth 5 — deep
  // monorepos with `tools/db/prisma/schema.prisma` 6+ levels below
  // workspace root should flatten or extend `findCanonicalPrismaSchemas`).
  // Add additional keys to the same `frameworkDiscoveries` map as
  // other framework plugins ship orchestrator-side scans.
  const projectPrismaSchemas = findCanonicalPrismaSchemas(workspaceRoot);
  if (projectPrismaSchemas.length > 0) {
    log(
      `Discovered ${projectPrismaSchemas.length} Prisma schema(s) under ${workspaceRoot} ` +
      `(bounded depth 5; nest deeper layouts under a closer workspace root if missed)`,
    );
  }
  const frameworkDiscoveries: Record<string, readonly string[]> = {
    [PRISMA_PLUGIN_ID]: projectPrismaSchemas,
  };

  // Analyze each repo. In watch-mode (`opts.onlyRepos`), skip the
  // ones not on the dirty list — their existing data stays in place
  // because the per-repo `analyze` call uses `clean: true` to wipe
  // and rewrite. Post-analysis finalizers + cross-repo stitching
  // still run below so the graph remains coherent.
  const onlyReposSet = opts.onlyRepos ? new Set(opts.onlyRepos) : null;
  const reposToRun = onlyReposSet
    ? config.repos.filter((r) => onlyReposSet.has(r.name))
    : config.repos;
  const totalRepos = reposToRun.length;
  let runIndex = 0;
  for (const repo of config.repos) {
    if (onlyReposSet && !onlyReposSet.has(repo.name)) continue;
    runIndex += 1;
    const repoPath = path.resolve(configDir, repo.path);
    log(`\n── Analyzing ${repo.name} (${repo.path}) ──`);
    opts.onRepoStart?.({ name: repo.name, index: runIndex, total: totalRepos });

    const start = Date.now();
    await analyze({
      rootDir: repoPath,
      dbPath: outputPath,
      repoName: repo.name,
      // In `--incremental`, defer to the hash diff; otherwise wipe
      // the repo's nodes to avoid stale data from previous runs.
      clean: !opts.incremental,
      incremental: opts.incremental ?? false,
      stitchMode: config.stitchMode ?? 'auto-exact',
      onProgress: opts.verbose ? (msg) => console.error(`  ${msg}`) : undefined,
      proxyRules: allProxyRules,
      applicationScope,
      externalCompilerPaths: Object.keys(projectCompilerPaths).length > 0 ? projectCompilerPaths : undefined,
      workspaceRoot,
      frameworkDiscoveries,
    });
    opts.onRepoEnd?.({ name: repo.name, index: runIndex, total: totalRepos, elapsedMs: Date.now() - start });
  }

  // Post-analysis: apply approved rules + suggest new ones.
  const store = new SQLiteCanonicalGraphStore(outputPath);
  try {
    // Step 0a: collapse synonymous DatabaseTable nodes (#384) — the
    // TypeORM-style receiver-name fallback can emit `appVersion` /
    // `AppVersion` for an entity whose canonical table is
    // `app_versions`. The visitor closure handles the case where the
    // entity is visited first; this finalizer handles the residual
    // order-dependent cases. Runs before the empty-system sweep so
    // any DatabaseSystem that only held inferred tables is correctly
    // re-evaluated below.
    const merged = store.mergeAliasedDatabaseTables();
    if (merged.mergedTables > 0) {
      log(`  ✓ merged ${merged.mergedTables} alias DatabaseTable(s) (${merged.rewrittenEdges} edge(s) rewired)`);
    }

    // Step 0b: sweep DatabaseSystem nodes that no plugin actually populated
    // with tables (#385). Framework plugins emit a system eagerly on
    // activation; if no tables landed under it, the system is noise.
    const pruned = store.pruneEmptyDatabaseSystems();
    if (pruned.deletedSystems > 0) {
      log(`  ✓ pruned ${pruned.deletedSystems} empty DatabaseSystem node(s)`);
    }

    // Build set of already-stitched caller IDs (batch query, not per-caller)
    const stitchedCallerIds = buildStitchedCallerSet(store);

    // Step 1: Apply human-approved stitch rules from config.
    if (config.stitchRules && config.stitchRules.length > 0) {
      log(`\n── Applying ${config.stitchRules.length} approved stitch rule(s) ──`);
      const applied = applyStitchRules(store, config.stitchRules, stitchedCallerIds, log);
      log(`  ✓ ${applied} new stitch(es) from approved rules`);
    }

    // Step 2: Detect unresolved callers and suggest new rules.
    const suggestions = detectPrefixMismatches(store, config.repos.map((r) => r.name), stitchedCallerIds);
    if (suggestions.length > 0) {
      log(`\n── Stitch rule suggestions (review before adding to config) ──`);
      for (const s of suggestions) {
        log(`  ⚡ ${s.description}`);
        log(`     ${s.affectedCount} caller(s) would be fixed`);
        log(`     Add to stitchRules in ${path.basename(absConfigPath)}:`);
        log(`     ${JSON.stringify(s.rule)}`);
      }
      log(`\n  To apply: add the rule(s) above to your project config and re-analyze.`);
    }
  } finally {
    store.close();
  }

  log(`\n── Project analysis complete ──`);
  log(`Graph saved to ${config.output}`);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a set of caller IDs that already have RESOLVES_TO_ENDPOINT edges.
 * Single batch query instead of per-caller lookups (M2 fix).
 */
function buildStitchedCallerSet(store: SQLiteCanonicalGraphStore): Set<string> {
  const edges = store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT');
  return new Set(edges.map((e) => e.from));
}

// ──────────────────────────────────────────────────────────────────────
// Stitch rule application (human-approved rules only)
// ──────────────────────────────────────────────────────────────────────

function applyStitchRules(
  store: SQLiteCanonicalGraphStore,
  rules: StitchRule[],
  stitchedCallerIds: Set<string>,
  log: (msg: string) => void,
): number {
  let total = 0;

  for (const rule of rules) {
    log(`  Rule: "${rule.name}" (${rule.from} → ${rule.to})`);

    const callers = store.findNodes('ClientSideAPICaller')
      .filter((c) => c.repository === rule.from);
    const endpoints = store.findNodes('APIEndpoint')
      .filter((e) => e.repository === rule.to);

    const newEdges: ResolvesToEndpointEdge[] = [];
    let ruleStitches = 0;
    for (const caller of callers) {
      if (stitchedCallerIds.has(caller.id)) continue;
      let url = caller.urlLiteral;
      if (!url) continue;

      url = transformUrl(url, rule.transform);

      const match = endpoints.find((e) => {
        const method = caller.httpMethod;
        if (method && e.httpMethod !== method && e.httpMethod !== 'ALL' && method !== 'ALL') return false;
        return matchRoute(url!, e.routePattern);
      });

      if (match) {
        newEdges.push({
          edgeType: 'RESOLVES_TO_ENDPOINT',
          from: caller.id,
          to: match.id,
          matchConfidence: 'high',
          matchedBy: 'inferred',
          strategy: `stitch-rule: ${rule.name}`,
        } as ResolvesToEndpointEdge);
        // Note: stitchedCallerIds is intentionally mutated here so
        // subsequent rules don't re-stitch already-matched callers.
        stitchedCallerIds.add(caller.id);
        ruleStitches++;
      }
    }

    // Batch commit all edges for this rule (minor: avoids per-edge commits).
    if (newEdges.length > 0) {
      store.commit({ nodes: [], edges: newEdges }, makeBatchMeta('stitch-rules'));
    }

    log(`    → ${ruleStitches} new stitch(es)`);
    total += ruleStitches;
  }

  return total;
}

/**
 * Apply URL transformations from a stitch rule.
 * Transforms are applied sequentially: stripPrefix → addPrefix → replacePrefix.
 * In practice, a rule should specify only ONE transform. If multiple are
 * set, they compose (e.g., strip then add = replace). This is intentional
 * for edge cases but not recommended — use replacePrefix instead.
 */
function transformUrl(url: string, transform: StitchRule['transform']): string {
  if (transform.stripPrefix && url.startsWith(transform.stripPrefix)) {
    url = url.slice(transform.stripPrefix.length);
    if (!url.startsWith('/')) url = '/' + url;
  }
  if (transform.addPrefix) {
    url = transform.addPrefix + url;
  }
  if (transform.replacePrefix) {
    if (url.startsWith(transform.replacePrefix.from)) {
      url = transform.replacePrefix.to + url.slice(transform.replacePrefix.from.length);
    }
  }
  return url;
}

// ──────────────────────────────────────────────────────────────────────
// Prefix mismatch detection (suggestions only — never auto-applied)
// ──────────────────────────────────────────────────────────────────────

interface StitchSuggestion {
  description: string;
  affectedCount: number;
  rule: StitchRule;
}

/**
 * Detect common prefix mismatches between unresolved callers and
 * endpoints. Returns suggestions that a human can review and add
 * to the project config.
 *
 * Current limitation: only suggests stripPrefix rules. addPrefix and
 * replacePrefix detection would require analyzing endpoint-side patterns
 * (e.g., endpoints with /v2/ prefix not present in caller URLs), which
 * is less common and not yet implemented.
 */
function detectPrefixMismatches(
  store: SQLiteCanonicalGraphStore,
  repoNames: string[],
  stitchedCallerIds: Set<string>,
): StitchSuggestion[] {
  const callers = store.findNodes('ClientSideAPICaller');
  const endpoints = store.findNodes('APIEndpoint');

  if (callers.length === 0 || endpoints.length === 0) return [];

  const unstitched = callers.filter((c) =>
    !stitchedCallerIds.has(c.id) &&
    c.urlLiteral &&
    !c.isExternal &&
    c.egressConfidence !== 'dynamic'
  );

  if (unstitched.length === 0) return [];

  const suggestions: StitchSuggestion[] = [];

  for (const callerRepo of repoNames) {
    for (const endpointRepo of repoNames) {
      if (callerRepo === endpointRepo) continue;

      const repoCallers = unstitched.filter((c) => c.repository === callerRepo);
      const repoEndpoints = endpoints.filter((e) => e.repository === endpointRepo);

      if (repoCallers.length === 0 || repoEndpoints.length === 0) continue;

      // Find common prefixes in unstitched caller URLs
      const prefixCounts = new Map<string, number>();
      for (const caller of repoCallers) {
        const url = caller.urlLiteral!;
        const segments = url.split('/').filter(Boolean);
        for (let len = 1; len <= Math.min(segments.length - 1, 3); len++) {
          const prefix = '/' + segments.slice(0, len).join('/');
          prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
        }
      }

      // For each common prefix, check if stripping would help
      for (const [prefix, count] of prefixCounts) {
        if (count < 3) continue;

        let wouldFix = 0;
        for (const caller of repoCallers) {
          const url = caller.urlLiteral!;
          if (!url.startsWith(prefix)) continue;
          const stripped = url.slice(prefix.length) || '/';
          const normalized = stripped.startsWith('/') ? stripped : '/' + stripped;

          const match = repoEndpoints.find((e) => {
            const method = caller.httpMethod;
            if (method && e.httpMethod !== method && e.httpMethod !== 'ALL' && method !== 'ALL') return false;
            return matchRoute(normalized, e.routePattern);
          });
          if (match) wouldFix++;
        }

        if (wouldFix >= 3) {
          suggestions.push({
            description: `Strip "${prefix}" from ${callerRepo} → ${endpointRepo} (${wouldFix} callers would match)`,
            affectedCount: wouldFix,
            rule: {
              name: `Strip ${prefix} prefix`,
              from: callerRepo,
              to: endpointRepo,
              transform: { stripPrefix: prefix },
            },
          });
        }
      }
    }
  }

  // Keep the best suggestion per repo pair
  const best = new Map<string, StitchSuggestion>();
  for (const s of suggestions) {
    const key = `${s.rule.from}→${s.rule.to}`;
    const existing = best.get(key);
    if (!existing || s.affectedCount > existing.affectedCount) {
      best.set(key, s);
    }
  }

  return [...best.values()].sort((a, b) => b.affectedCount - a.affectedCount);
}

/**
 * Match a URL against a route pattern.
 * Supports :param (Express/Gin/Koa) and {param} (Fastify/Spring/Laravel)
 * segments as wildcards. Handles trailing slashes and double slashes.
 */
function matchRoute(url: string, pattern: string): boolean {
  if (url === pattern) return true;

  // Normalize: strip trailing slash, collapse double slashes
  const normalize = (s: string) => s.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const urlParts = normalize(url).split('/');
  const patternParts = normalize(pattern).split('/');

  if (urlParts.length !== patternParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.startsWith(':')) continue;    // :param (Express, Gin, Koa)
    if (pp.startsWith('{')) continue;    // {param} (Fastify, Spring, Laravel)
    if (pp !== urlParts[i]) return false;
  }

  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Project init
// ──────────────────────────────────────────────────────────────────────

/**
 * #292 — expand a single workspace glob to a list of {path, name}
 * repo entries. Handles:
 *   - `<dir>/*`   — immediate subdirs (with package.json)
 *   - `<dir>/**` — recursive descent (pnpm semantics: any package
 *     anywhere under <dir>; bounded to a sensible depth)
 *   - `<exact-path>` — explicit single workspace
 *
 * Pre-fix only `<dir>/*` worked, so monorepos like hoppscotch with
 * `packages: [packages/**]` produced an empty repos array.
 *
 * Recursion stops at the first package.json found on any path, so a
 * monorepo where workspace A contains workspace B (e.g.
 * `packages/sub/foo/`) doesn't return both A and B — A wins.
 */
function expandWorkspaceGlob(
  absRoot: string,
  glob: string,
): Array<{ path: string; name: string }> {
  const result: Array<{ path: string; name: string }> = [];
  const isRecursive = glob.endsWith('/**');
  const isSingle = !isRecursive && glob.endsWith('/*');

  // Skip pnpm negation globs ('!packages/excluded/*'). The expander
  // treats them as literal paths today; rather than silently include
  // matches that the user explicitly excluded, drop the glob entirely.
  // (Note: this is conservative — the user's intended set of repos
  // may need manual editing if they rely on negation patterns.)
  if (glob.startsWith('!')) return result;

  if (isRecursive || isSingle) {
    const baseSegments = isRecursive ? glob.slice(0, -3) : glob.slice(0, -2);
    const baseDir = path.join(absRoot, baseSegments);
    if (!fs.existsSync(baseDir)) return result;
    const maxDepth = isRecursive ? 4 : 1;

    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const childDir = path.join(dir, entry.name);
        if (fs.existsSync(path.join(childDir, 'package.json'))) {
          const relPath = path.relative(absRoot, childDir).split(path.sep).join('/');
          result.push({ path: `./${relPath}`, name: entry.name });
          // Don't descend into a directory that's already a package.
        } else if (isRecursive) {
          walk(childDir, depth + 1);
        }
      }
    };
    walk(baseDir, 1);
    return result;
  }

  // Explicit path (e.g., 'packages/foo' or 'apps/api')
  const dir = path.join(absRoot, glob);
  if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'package.json'))) {
    result.push({ path: `./${glob}`, name: path.basename(glob) });
  }
  return result;
}

/**
 * Auto-detect workspace packages from pnpm-workspace.yaml or
 * package.json workspaces and generate a project config file.
 */
export function initProject(rootDir: string): ProjectConfig {
  const absRoot = path.resolve(rootDir);
  const projectName = path.basename(absRoot);

  const pnpmWorkspacePath = path.join(absRoot, 'pnpm-workspace.yaml');
  let workspaceGlobs: string[] = [];

  if (fs.existsSync(pnpmWorkspacePath)) {
    const content = fs.readFileSync(pnpmWorkspacePath, 'utf-8');
    const lines = content.split('\n');
    let inPackages = false;
    for (const line of lines) {
      if (/^packages:/i.test(line.trim())) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\s+-\s+/.test(line)) {
        const match = line.match(/^\s+-\s+["']?([^"'\s]+)["']?/);
        if (match) workspaceGlobs.push(match[1]);
      } else if (inPackages && !/^\s*$/.test(line) && !/^\s*#/.test(line)) {
        inPackages = false;
      }
    }
  }

  if (workspaceGlobs.length === 0) {
    const pkgPath = path.join(absRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (Array.isArray(pkg.workspaces)) {
          workspaceGlobs = pkg.workspaces;
        } else if (pkg.workspaces?.packages) {
          workspaceGlobs = pkg.workspaces.packages;
        }
      } catch { /* ignore */ }
    }
  }

  if (workspaceGlobs.length === 0) {
    return {
      name: projectName,
      output: `${projectName}.db`,
      repos: [{ path: '.', name: projectName }],
    };
  }

  const repos: Array<{ path: string; name: string }> = [];
  // Dedup by absolute path so two overlapping globs (`packages/*` +
  // `packages/**`) don't double-add the same workspace.
  const seenAbs = new Set<string>();
  for (const glob of workspaceGlobs) {
    for (const repo of expandWorkspaceGlob(absRoot, glob)) {
      const absKey = path.join(absRoot, repo.path);
      if (seenAbs.has(absKey)) continue;
      seenAbs.add(absKey);
      repos.push(repo);
    }
  }

  return {
    name: projectName,
    output: `${projectName}.db`,
    repos,
  };
}

/**
 * #345 — Walk up from `configDir` to find the directory that actually
 * declares a workspace. Looks for any of:
 *   - `pnpm-workspace.yaml`
 *   - `package.json` with a `workspaces` field (npm / yarn classic / yarn berry)
 *   - `lerna.json`
 *   - `nx.json`
 *   - `turbo.json`
 *
 * Returns the first ancestor (inclusive) containing one of these
 * markers, or falls back to `configDir` when none is found.
 *
 * Bounded by (in order of precedence):
 *   1. A `.git` directory — never cross a repository boundary.
 *   2. `$HOME` — never read user-level config files as if they were
 *      project workspace declarations. A stray `~/package.json` with
 *      a `workspaces` field used to be picked as the workspace root
 *      on dev machines that store tooling there.
 *   3. The filesystem root.
 *
 * The result is `realpath`-resolved so symlinked paths normalize
 * to a canonical form — important when downstream code compares
 * paths or feeds them into `findCanonicalPrismaSchemas`, which
 * also resolves real paths.
 */
export function findWorkspaceRoot(configDir: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? null;
  const homeReal = home ? safeRealpath(home) : null;
  let current = path.resolve(configDir);
  while (true) {
    if (isWorkspaceMarkerDir(current)) return safeRealpath(current);
    // .git sentinel — stop at a repository boundary. The .git
    // directory marks the repo root, so when we encounter one
    // WITHOUT having found a workspace marker first, the repo root
    // itself is the best answer (it's the natural boundary of any
    // analysis, and is what `dirname(configPath)` would have
    // produced for a typical single-repo layout).
    if (fs.existsSync(path.join(current, '.git'))) return safeRealpath(current);

    const parent = path.dirname(current);
    if (parent === current) break; // hit filesystem root
    // $HOME sentinel — don't walk into the user-level config space.
    // A stray `~/package.json` with a `workspaces` field used to
    // get picked as the workspace root on dev machines that store
    // tooling there. We compare `realpath`s because either path
    // may be symlinked (`/home` → `/Users` on macOS, or `~` itself).
    if (homeReal && safeRealpath(parent) === homeReal) break;
    current = parent;
  }
  return safeRealpath(configDir);
}

function isWorkspaceMarkerDir(dir: string): boolean {
  if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return true;
  if (fs.existsSync(path.join(dir, 'lerna.json'))) return true;
  if (fs.existsSync(path.join(dir, 'nx.json'))) return true;
  if (fs.existsSync(path.join(dir, 'turbo.json'))) return true;
  // npm / yarn classic / yarn berry: `package.json` with a `workspaces` field.
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { workspaces?: unknown };
      if (pkg.workspaces !== undefined) return true;
    } catch {
      // Malformed package.json — ignore, treat as not-a-marker.
    }
  }
  return false;
}

/**
 * Resolve symlinks, falling back to the input when the path can't be
 * realpath'd (e.g., the input doesn't exist on disk yet). Keeps the
 * walk-up robust on missing/transient inputs without throwing.
 */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
