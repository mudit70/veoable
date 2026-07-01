import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { extractPrismaSchemas } from './schema-parser.js';
import { createPrismaVisitor } from './visitor.js';

/**
 * Prisma framework plugin (#47).
 *
 * Implements `FrameworkPlugin` from `@veoable/plugin-api` and
 * contributes both project-level and file-level extraction:
 *
 *  - `onProjectLoaded(ctx)` — parses every `schema.prisma` file under
 *    the project root and emits `DatabaseSystem` / `DatabaseTable` /
 *    `DatabaseColumn` nodes and `TABLE_IN` / `COLUMN_IN` /
 *    `FOREIGN_KEY` edges. Called once per project load.
 *  - `visitor` — a `TsFrameworkVisitor` that detects Prisma Client
 *    call sites in TypeScript source (`prisma.user.findMany(...)`,
 *    etc.) and emits `DatabaseInteraction` / `READS` / `WRITES` /
 *    `PERFORMED_BY` edges connecting them back to the tables the
 *    schema parser emitted.
 *
 * The visitor needs to know the `DatabaseSystem` id the schema
 * parser produced so the edges it emits match the tables that
 * already exist in the graph. That id is only known AFTER
 * `onProjectLoaded` runs, so the visitor is constructed lazily on
 * first access and is a no-op until `onProjectLoaded` has been
 * called. A single `PrismaPlugin` instance is single-project: to
 * analyze multiple projects, create a new instance per project.
 */
export const PRISMA_PLUGIN_ID = 'prisma' as const;

export class PrismaPlugin implements FrameworkPlugin {
  readonly id = PRISMA_PLUGIN_ID;
  readonly language = 'ts';

  /** DatabaseSystem id discovered during `onProjectLoaded`. */
  private _systemId: string | null = null;

  /** Cached visitor bound to the current project's system id. */
  private _visitor: TsFrameworkVisitor | null = null;

  /**
   * Returns true when the current project looks like a Prisma project:
   * either there's a `@prisma/client` (or `prisma`) dependency in the
   * root `package.json`, or there's a `prisma/schema.prisma` / any
   * `*.prisma` file under the root.
   */
  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    if ('@prisma/client' in deps || 'prisma' in deps) return true;

    const canonicalSchemaPath = path.join(ctx.rootDir, 'prisma', 'schema.prisma');
    if (fs.existsSync(canonicalSchemaPath)) return true;
    if (ctx.files.some((f) => f.endsWith('.prisma'))) return true;
    // #344 — Orchestrator pre-discovered schemas. When present (and
    // non-empty), trust that result over re-scanning. `[]` (empty
    // array) means the orchestrator scanned and found nothing — DO
    // NOT fall through to a local scan that would just rediscover
    // the same absence.
    const preDiscovered = ctx.frameworkDiscoveries?.[PRISMA_PLUGIN_ID];
    if (Array.isArray(preDiscovered)) {
      return preDiscovered.length > 0;
    }
    // #334 — In a monorepo sub-repo, the schema may live in a
    // sibling package. Check the workspace root too. This path only
    // fires when the orchestrator did NOT pre-discover (single-repo
    // `analyze` invocation, or unit tests building a literal
    // ProjectContext without `frameworkDiscoveries`).
    if (ctx.workspaceRoot && ctx.workspaceRoot !== ctx.rootDir) {
      const workspaceSchemaPath = path.join(ctx.workspaceRoot, 'prisma', 'schema.prisma');
      if (fs.existsSync(workspaceSchemaPath)) return true;
      if (findPrismaSchemaUnder(ctx.workspaceRoot) !== null) return true;
    }
    return false;
  }

  /**
   * Project-level extraction hook (#67 contract extension, PR 2/2
   * of #47). Parses every `*.prisma` file under `ctx.rootDir`, caches
   * the discovered `DatabaseSystem` id so the visitor can produce
   * matching `DatabaseTable` references, and returns the schema
   * batch for the orchestrator to commit.
   *
   * Calling this twice on the same plugin instance is safe (the
   * second call reparses and overwrites the cached system id) but
   * not necessarily useful.
   */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    let batch = extractPrismaSchemas({ rootDir: ctx.rootDir });
    let system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');

    // #344 — Prefer the orchestrator's pre-discovered schema list
    // when present. In a project-config-driven multi-repo analyze,
    // the CLI walks the workspace exactly once and stashes the
    // discovered absolute paths under
    // `ctx.frameworkDiscoveries[PRISMA_PLUGIN_ID]`, so every per-
    // repo plugin instance reuses the same result instead of
    // re-scanning.
    //
    // PRECEDENCE: a schema discovered LOCALLY in `ctx.rootDir`
    // always wins. The orchestrator-supplied list is consulted only
    // when the local extraction produced nothing — so a repo that
    // genuinely owns its own schema keeps owning it, even if the
    // workspace scan also picked up sibling schemas.
    //
    // Tri-state semantics of the discovery key:
    //   - non-empty list → use the COMMON ANCESTOR directory of all
    //     paths as the extraction root, so a `prismaSchemaFolder`
    //     layout (datasource shard + N model shards in a `prisma/`
    //     dir) correctly picks the shared parent. Using
    //     `dirname(preDiscovered[0])` alone broke when the
    //     alphabetically-first entry was a sub-dir shard that
    //     didn't contain the datasource file (#364).
    //   - empty array → orchestrator scanned and found nothing;
    //     skip the workspaceRoot fallback.
    //   - key absent → orchestrator didn't pre-discover (single-repo
    //     `analyze` or unit tests); fall back to the #334
    //     workspaceRoot scan below.
    const preDiscovered = ctx.frameworkDiscoveries?.[PRISMA_PLUGIN_ID];
    if (!system && Array.isArray(preDiscovered)) {
      if (preDiscovered.length > 0) {
        const schemaDir = commonAncestorDir(preDiscovered);
        batch = extractPrismaSchemas({ rootDir: schemaDir });
        system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
      }
    } else if (!system && ctx.workspaceRoot && ctx.workspaceRoot !== ctx.rootDir) {
      // #334 — Cross-package fallback when orchestrator did not
      // pre-discover. Narrow the scan to the directory containing
      // the workspace's schema so the recursive walk in
      // `findSchemaFiles` doesn't traverse the entire monorepo.
      const schemaPath = findPrismaSchemaUnder(ctx.workspaceRoot);
      if (schemaPath) {
        const schemaDir = path.dirname(schemaPath);
        batch = extractPrismaSchemas({ rootDir: schemaDir });
        system = batch.nodes.find((n) => n.nodeType === 'DatabaseSystem');
      }
    }
    this._systemId = system?.id ?? null;
    // Invalidate any previously built visitor so the next access
    // rebuilds it with the new system id.
    this._visitor = null;
    return batch;
  }

  /**
   * TS call-site visitor. Constructed lazily on first access using
   * the `DatabaseSystem` id discovered by `onProjectLoaded`. If
   * `onProjectLoaded` has not been called yet, returns a no-op
   * visitor so registration against the language plugin still
   * succeeds and any subsequent `extractFile` calls don't emit
   * mis-rooted edges.
   */
  get visitor(): TsFrameworkVisitor {
    if (this._visitor) return this._visitor;
    if (this._systemId) {
      this._visitor = createPrismaVisitor({ systemId: this._systemId });
    } else {
      this._visitor = {
        language: 'ts',
        onNode(): void {
          // No-op: `onProjectLoaded` has not yet discovered a
          // DatabaseSystem, so we have nothing to attribute call sites
          // to. Callers should call `onProjectLoaded` before
          // extraction.
        },
      };
    }
    return this._visitor;
  }

  /**
   * Direct access to the schema-extraction side for callers that don't
   * want to go through `onProjectLoaded`. Identical to what
   * `onProjectLoaded` returns but does NOT cache the system id for
   * the visitor — use `onProjectLoaded` if you plan to also register
   * the visitor.
   */
  extractSchemas(rootDir: string): NodeBatch {
    return extractPrismaSchemas({ rootDir });
  }
}

/**
 * #334 — Cheap recursive scan for the FIRST canonical Prisma schema
 * under a directory. Returns the file path if found, null otherwise.
 *
 * Used by `appliesTo` to decide whether to activate the plugin for
 * a sub-repo that imports a sibling package's Prisma client, AND
 * by `onProjectLoaded` to narrow the schema-extraction directory
 * so we don't re-walk the entire workspace tree (which is
 * uncapped in `findSchemaFiles` — feeding it the schema's parent
 * directory avoids the perf cliff on large monorepos).
 *
 * #348 — Match only files named `schema.prisma` (canonical Prisma
 * convention) OR any `*.prisma` file inside a `prisma/` directory.
 * Avoids spurious activation on test fixtures or unrelated `.prisma`
 * files scattered through a monorepo.
 *
 * Bounded depth to keep `appliesTo` fast on huge monorepos.
 */
function findPrismaSchemaUnder(dir: string, depth = 0, maxDepth = 5, inPrismaDir = false): string | null {
  if (depth > maxDepth) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Sort entries by name for cross-filesystem determinism. Without
  // this, the "first canonical schema" returned depends on the
  // platform's readdir order (APFS often sorted, ext4 insertion
  // order). The orchestrator's `findCanonicalPrismaSchemas` sorts
  // its results — sorting here too means both paths agree on which
  // schema is "first" in a multi-schema workspace (#147 / first-pick
  // agreement).
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.prisma')) {
      // Accept only the canonical filename OR any .prisma inside a
      // `prisma/` directory — avoids matching e.g. test fixtures.
      if (e.name === 'schema.prisma' || inPrismaDir) return full;
      continue;
    }
    if (e.isDirectory()) {
      const found = findPrismaSchemaUnder(
        full,
        depth + 1,
        maxDepth,
        inPrismaDir || e.name === 'prisma',
      );
      if (found) return found;
    }
  }
  return null;
}

/**
 * #364 — Compute the directory that contains every absolute path in
 * `paths`. Used to narrow the extraction root for the orchestrator-
 * supplied schema list.
 *
 * The previous shortcut (`dirname(paths[0])`) silently broke on
 * `prismaSchemaFolder` layouts whose alphabetically-first entry was
 * a model shard in a sub-directory:
 *
 *   [0] /repo/packages/prisma/models/billing.prisma   ← sorted first
 *   [1] /repo/packages/prisma/models/event.prisma
 *   ...
 *   [8] /repo/packages/prisma/schema.prisma           ← has datasource
 *
 * `dirname([0])` = `.../prisma/models` — contains no datasource, so
 * the two-pass parser returns an empty batch for every consumer
 * sub-repo.
 *
 * `commonAncestorDir` walks the path segments in parallel and stops
 * at the first divergence, returning `.../prisma` — which the
 * recursive walk then correctly traverses to find both
 * `schema.prisma` and every `models/*.prisma`.
 *
 * Edge cases:
 *   - empty input → the caller is responsible for not invoking this
 *     (current call site guards with `length > 0`)
 *   - single path → returns its dirname (parity with the old shortcut)
 *   - paths across different roots → returns the FS root, which is
 *     safe (extraction over `/` returns empty, not a security issue
 *     because `findSchemaFiles` doesn't traverse `node_modules` or
 *     dotdirs anyway)
 */
function commonAncestorDir(paths: readonly string[]): string {
  if (paths.length === 1) return path.dirname(paths[0]);
  const parents = paths.map((p) => path.dirname(p).split(path.sep));
  const minLen = Math.min(...parents.map((p) => p.length));
  const out: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const seg = parents[0][i];
    if (parents.every((p) => p[i] === seg)) out.push(seg);
    else break;
  }
  return out.join(path.sep) || path.sep;
}
