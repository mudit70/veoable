import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { makeBatchMeta, type LanguagePlugin, type ProjectContext } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { idFor, SCHEMA_VERSION } from '@adorable/schema';
import {
  FLOW_STITCHER_PRODUCER_ID,
  createFlowWalker,
  discoverProxyRules,
  stitchStore,
  type Flow,
  type ProxyRule,
} from '@adorable/flow-stitcher';
import { resolveAngularTemplates, resolveInlineHandlers } from '@adorable/lang-html';
import { resolveRustCrossModCalls } from '@adorable/lang-rust';
import { mergeTraceFiles } from './merge-trace.js';
import {
  buildProjectContext,
  createLanguagePlugins,
  detectPlugins,
  discoverSourceFiles,
  discoverWorkspacePackages,
  groupFilesByLanguage,
  synthesizeWorkspaceCompilerPaths,
} from './discover.js';

/**
 * #253 — heuristic threshold above which single-shot analyze
 * regularly OOMs at the default 8 GB heap. The number is empirical:
 * veodiagram (~6k files) crashes; smaller monorepos do not. Tunable
 * via env later if needed.
 */
const LARGE_PROJECT_FILE_THRESHOLD = 5000;

/**
 * Result of a full analysis run. Contains everything the CLI
 * formatter needs to produce human-readable or machine-readable
 * output.
 */
export interface AnalysisResult {
  rootDir: string;
  sourceFileCount: number;
  /**
   * Every plugin whose activation gate fired. Includes plugins that
   * activated by design but produced zero graph nodes for this project
   * (e.g. `framework-fetch` on a project with a `fetch(...)` reference
   * inside an unreachable code path, `framework-bundler` on a project
   * where the bundler config exists but no calls were instrumented).
   * Kept on the result so users can see "this plugin saw your stack"
   * even when nothing surfaced.
   */
  detectedPlugins: string[];
  /**
   * Subset of `detectedPlugins` that actually contributed nodes to the
   * graph. This is the "working set" — what's downstream code, MCP
   * tools, and the report driver should treat as the user's real
   * framework footprint (#523 item 3). A plugin missing from this list
   * but present in `detectedPlugins` is a "detected-but-silent" case.
   */
  emittingPlugins: string[];
  schemaSummary: {
    systems: number;
    tables: number;
    columns: number;
  };
  stitchSummary: {
    resolved: number;
    dynamic: number;
  };
  flows: Flow[];
  completeFlowCount: number;
  partialFlowCount: number;
  store: SQLiteCanonicalGraphStore;
}

export interface AnalyzeOptions {
  /** Absolute path to the project root. */
  rootDir: string;
  /** SQLite database path. Defaults to `:memory:`. */
  dbPath?: string;
  /** Additional exclude patterns for source discovery. */
  exclude?: string[];
  /** Max call-graph traversal depth for the flow walker. */
  maxCallDepth?: number;
  /**
   * Stitching mode:
   * - `none`: build graphs only, no stitching
   * - `auto-exact`: auto-stitch deterministic matches only (default)
   * - `auto-all`: auto-stitch everything (v1 behavior)
   */
  stitchMode?: 'none' | 'auto-exact' | 'auto-all';
  /** Override the repository name (default: derived from rootDir basename). */
  repoName?: string;
  /** Delete existing nodes for this repo before re-analyzing. */
  clean?: boolean;
  /**
   * #294 Phase 2a — incremental mode. When true, `analyze` consults
   * the `source_file_hashes` sidecar table to decide which files
   * changed since the last run, and only re-extracts those. Files
   * unchanged on disk keep their existing nodes/edges. Removed files
   * have their nodes/edges purged. Files new since the last run are
   * extracted normally.
   *
   * Mutually exclusive with `clean: true`. If both are set, `clean`
   * wins (the cache is rebuilt from scratch). If the stored hashes
   * were recorded against a different `SCHEMA_VERSION`, the cache is
   * invalidated and the run falls back to a full clean re-analyze
   * with a logged warning.
   */
  incremental?: boolean;
  /** Called with progress messages when verbose mode is on. */
  onProgress?: (message: string) => void;
  /**
   * Optional pre-discovered proxy rules (#188). Used by
   * `analyzeProject` to pass the union of all repos' rules into each
   * per-repo analyze. When omitted, `analyze` discovers rules from
   * `rootDir` itself.
   */
  proxyRules?: readonly ProxyRule[];
  /**
   * Application-pair scope (#255). When supplied, restricts each
   * caller's matchable endpoints to those whose `repository` shares
   * an application with the caller's `repository`. Default behavior
   * (no scope) preserves v1 cross-repo stitching.
   */
  applicationScope?: import('@adorable/flow-stitcher').ApplicationScope;
  /**
   * Pre-synthesized compiler paths (#325). When `analyze` is called
   * per-repo by `analyzeProject`, the workspace declaration usually
   * lives at the project's parent directory, not the repo's rootDir.
   * The orchestrator pre-discovers workspace packages at that level
   * and passes them in so cross-package alias imports
   * (`@dub/prisma`, `@calcom/prisma`, etc.) resolve through ts-morph.
   * When this is set, `analyze` merges it with any locally-discovered
   * paths (local takes precedence for matching keys).
   */
  externalCompilerPaths?: Record<string, string[]>;
  /**
   * #334 — Outer workspace root, when the per-repo analyze is part of
   * a `project analyze` invocation. Plugins that need cross-package
   * resources (Prisma schemas in sibling packages, etc.) consult this
   * via `ProjectContext.workspaceRoot`.
   */
  workspaceRoot?: string;
  /**
   * #344 — Pre-discovered framework-specific paths from the
   * orchestrator's one-time workspace scan, keyed by plugin id.
   * Threaded into `ProjectContext.frameworkDiscoveries`. Plugins
   * consume their own key (`ctx.frameworkDiscoveries?.[id]`) and
   * skip their own scans when the key is present — saving N×
   * workspace walks in a multi-repo `project analyze`. Pass
   * undefined / omit to let plugins scan on their own (single-repo
   * `analyze` paths preserve prior behavior this way).
   */
  frameworkDiscoveries?: Readonly<Record<string, readonly string[]>>;
  /**
   * #535 — Trace JSONL files produced by `@adorable/trace`'s test-
   * bootstrap hook. When supplied, the analyze pass loads each file
   * and materializes runtime-observed edges as canonical-graph
   * `ClientSideAPICaller` + `MAKES_REQUEST` nodes/edges with
   * `framework: 'trace'`, providing a fallback for static-analysis
   * gaps.
   */
  mergeTracePaths?: ReadonlyArray<string>;
}

/**
 * Run the full Adorable analysis pipeline on a project:
 *
 *  1. Discover source files
 *  2. Auto-detect framework plugins
 *  3. Run project-level prelude (schema extraction) for plugins
 *     that have `onProjectLoaded`
 *  4. Register visitors and extract every source file
 *  5. Run the URL stitcher
 *  6. Walk all flows
 *
 * Returns a structured `AnalysisResult` with everything the CLI
 * formatter needs.
 */
export async function analyze(opts: AnalyzeOptions): Promise<AnalysisResult> {
  const { rootDir, dbPath = ':memory:', maxCallDepth = 10, stitchMode = 'auto-exact', repoName, clean = false, incremental = false, onProgress } = opts;
  const log = onProgress ?? (() => {});
  const absRoot = path.resolve(rootDir);

  // 1. Discover source files.
  log(`Scanning ${absRoot} for source files...`);
  const files = discoverSourceFiles(absRoot, { exclude: opts.exclude });
  log(`Found ${files.length} source files`);

  // #253 — early OOM warning. Single-shot analyze of very large monorepos
  // can exhaust V8's heap inside ts-morph's type checker. The workaround
  // is `project analyze` with a project config that decomposes the repo
  // into per-package analyses sharing one DB. Threshold is conservative;
  // bump-default-heap from heap-bump.ts gives 8GB which covers most
  // mid-sized repos.
  if (files.length > LARGE_PROJECT_FILE_THRESHOLD) {
    log(
      `  warning: ${files.length} source files detected — large projects may run out of memory.\n` +
      `    If analyze fails with "JavaScript heap out of memory", run\n` +
      `    \`adorable project init\` to generate a per-package config and use\n` +
      `    \`adorable project analyze <config>\` instead.`
    );
  }

  if (files.length === 0) {
    const store = new SQLiteCanonicalGraphStore(dbPath);
    return {
      rootDir: absRoot,
      sourceFileCount: 0,
      detectedPlugins: [],
      emittingPlugins: [],
      schemaSummary: { systems: 0, tables: 0, columns: 0 },
      stitchSummary: { resolved: 0, dynamic: 0 },
      flows: [],
      completeFlowCount: 0,
      partialFlowCount: 0,
      store,
    };
  }

  // 2. Auto-detect framework plugins.
  const ctx = buildProjectContext(absRoot, files, {
    exclude: opts.exclude,
    workspaceRoot: opts.workspaceRoot,
    frameworkDiscoveries: opts.frameworkDiscoveries,
  });
  const plugins = detectPlugins(ctx);
  const pluginIds = plugins.map((p) => p.id);
  log(`Detected frameworks: ${pluginIds.join(', ') || 'none'}`);

  // Surface monorepo coverage: how many subpackage manifests we read
  // and how many of the matched plugins came from a subpackage rather
  // than the root. Helps users notice when activation is reaching
  // into nested workspaces (#184).
  const subManifestCount = (ctx.manifests ?? []).filter((m) => m.relPath !== '.').length;
  if (subManifestCount > 0) {
    log(`  ✓ scanned ${subManifestCount} subpackage manifest(s) for framework activation`);
  }

  // Detect declared workspace metadata (#195) and synthesize compiler
  // `paths` so cross-package alias imports (`@scope/pkg/...`) resolve
  // through ts-morph without the user needing to `pnpm install` first.
  // Layout-B monorepos (no workspace declaration) get an empty map and
  // rely on the name-based fallback in `findUniqueExportedDeclaration`.
  const workspacePackages = discoverWorkspacePackages(absRoot, ctx.manifests ?? []);
  const localCompilerPaths = synthesizeWorkspaceCompilerPaths(absRoot, workspacePackages);
  // Merge with externally-supplied paths (#325). The project
  // orchestrator (`analyzeProject`) pre-discovers workspace metadata
  // at the project root and supplies sibling-package paths here so
  // per-repo analyses can resolve cross-package imports
  // (`@dub/prisma`, `@calcom/prisma`, …). Local paths win on
  // collisions because they're sourced from the same rootDir.
  const compilerPaths: Record<string, string[]> = {
    ...(opts.externalCompilerPaths ?? {}),
    ...localCompilerPaths,
  };
  if (workspacePackages.length > 0) {
    log(`  ✓ found ${workspacePackages.length} declared workspace package(s); synthesized compiler paths for cross-package imports`);
  }

  // 3. Store setup.
  const store = new SQLiteCanonicalGraphStore(dbPath);
  const effectiveRepoName = repoName ?? path.basename(absRoot);

  // 3b. Clean previous data for this repo if requested.
  // `clean` and `incremental` are mutually exclusive — `clean` wins
  // (full re-build, drops the sidecar hash cache for this repo too
  // since the canonical nodes it referenced are gone).
  if (clean) {
    const { deletedNodes, deletedEdges } = store.deleteByRepository(effectiveRepoName);
    if (deletedNodes > 0 || deletedEdges > 0) {
      log(`  ✓ cleaned: ${deletedNodes} node(s), ${deletedEdges} edge(s) for repo "${effectiveRepoName}"`);
    }
    // Drop stored hashes for this repo so the next incremental run
    // re-extracts everything (the canonical nodes they pointed at
    // were just deleted).
    for (const h of store.listSourceFileHashes(effectiveRepoName)) {
      store.deleteSourceFileHash(effectiveRepoName, h.filePath);
    }
  }

  // 3c. #294 Phase 2a — incremental: compute which files actually
  // changed since the last run and narrow extraction to that subset.
  // Schema-version mismatch invalidates the cache: we drop everything
  // and fall back to a full clean re-analyze with a logged warning.
  let filesToExtract = files;
  let removedFileCount = 0;
  let incrementalActive = false;
  if (incremental && !clean) {
    const stored = store.listSourceFileHashes(effectiveRepoName);
    const versionMismatch = stored.some((h) => h.schemaVersion !== SCHEMA_VERSION);
    if (versionMismatch) {
      log(
        `  ! schema version drift detected (cache vs SCHEMA_VERSION=${SCHEMA_VERSION}); ` +
        `falling back to full re-analyze`,
      );
      store.deleteByRepository(effectiveRepoName);
      for (const h of stored) {
        store.deleteSourceFileHash(effectiveRepoName, h.filePath);
      }
    } else {
      incrementalActive = true;
      const storedByPath = new Map(stored.map((h) => [h.filePath, h.hash]));
      // `files` are already relative to rootDir (see
      // `discoverSourceFiles` in cli/src/discover.ts). Store the same
      // rel → rel mapping so the SourceFile.filePath shape lines up.
      const currentRelSet = new Set<string>(files);

      // Removed files: in stored but not in current.
      for (const h of stored) {
        if (!currentRelSet.has(h.filePath)) {
          store.deleteByFile(effectiveRepoName, h.filePath);
          store.deleteSourceFileHash(effectiveRepoName, h.filePath);
          removedFileCount += 1;
        }
      }

      // Changed + new: file's current hash differs from stored.
      // We collect the changed list BEFORE issuing any deleteByFile so
      // the reverse-import cascade (below) can still see the IMPORTS
      // edges pointing into the changed files. `deleteByFile` cascades
      // through to_id too, so doing the deletes first would leave the
      // cascade with nothing to walk.
      const changed: string[] = [];
      for (const rel of files) {
        const abs = path.join(absRoot, rel);
        const currentHash = computeFileHash(abs);
        if (!currentHash) {
          // Unreadable; queue for extraction so the existing
          // skip-on-error path handles it consistently.
          changed.push(rel);
          continue;
        }
        const prev = storedByPath.get(rel);
        if (prev !== currentHash) {
          changed.push(rel);
        }
      }
      // #294 Phase 2a sub-PR 2 — 1-hop reverse-import invalidation.
      // Cross-file resolution can produce edges (CALLS_FUNCTION,
      // IMPORTS, RESOLVES_TO_ENDPOINT, etc.) keyed off symbols in
      // a different file. If file B is unchanged but it imports
      // from changed file A, B's edges to A may now point at a
      // deleted (and about-to-be-recreated) node. Re-extract every
      // direct importer of a changed file so its edges are rebuilt.
      //
      // We only chase 1 hop. Transitive importers (importer-of-
      // importer) may still have stale edges if the symbol they
      // chase passes through a re-exporter. Acceptable trade-off
      // for v1; a follow-up could expand to a 2+ hop walk or do an
      // edge-rewrite pass.
      const importerInvalidated = new Set<string>();
      if (changed.length > 0) {
        const changedSet = new Set(changed);
        for (const rel of changed) {
          const targetId = idFor.sourceFile({ repository: effectiveRepoName, filePath: rel });
          const edges = store.findEdges(null, targetId, 'IMPORTS');
          for (const e of edges) {
            const fromNode = store.getNodeById(e.from);
            if (!fromNode || fromNode.nodeType !== 'SourceFile') continue;
            if (fromNode.repository !== effectiveRepoName) continue;
            const importerRel = fromNode.filePath;
            if (changedSet.has(importerRel)) continue; // already queued
            importerInvalidated.add(importerRel);
          }
        }
      }

      // #420 — cascade fan-out cap. A hot file (shared types,
      // utility module) can be imported by hundreds of others.
      // Editing it would trigger N single-file extracts per cycle,
      // each paying loadProject + per-file orchestration cost. Above
      // a threshold the full repo re-extract is cheaper AND
      // bounded — so we bail.
      //
      // Two caps; bail if EITHER trips:
      //   - countCap: absolute file count (default 100, env-overridable).
      //     Catches huge repos where 30% of files is still too many.
      //   - ratioCap: 30% of discovered files. Catches small/medium
      //     repos where the count cap is irrelevant.
      // OR semantics mean the effective threshold is the smaller of
      // the two — the smaller cap dominates whichever side of the
      // crossover repo size we're on.
      const wouldExtract = changed.length + importerInvalidated.size;
      const envCap = Number(process.env.ADORABLE_MAX_CASCADE_FILES);
      const countCap = Number.isFinite(envCap) && envCap > 0
        ? Math.floor(envCap)
        : 100;
      const ratioCap = Math.max(1, Math.floor(files.length * 0.3));
      const cascadeTooLarge = wouldExtract > countCap || wouldExtract > ratioCap;

      if (cascadeTooLarge) {
        log(
          `  ↻ cascade fan-out ${wouldExtract}/${files.length} exceeds cap ` +
          `(>${countCap} or >${ratioCap}); falling back to full re-extract`,
        );
        store.deleteByRepository(effectiveRepoName);
        // Hashes stay in the sidecar — the per-file extract loop will
        // overwrite them with current values, and unchanged files
        // will produce identical hashes so the next incremental cycle
        // still sees them as up to date.
        filesToExtract = files;
      } else {
        // Now do all the deletes — changed files first, then the
        // cascaded importers. Their hashes stay (for importers) so
        // the next incremental run treats them as unchanged unless
        // the file contents shifted.
        for (const rel of changed) {
          store.deleteByFile(effectiveRepoName, rel);
        }
        for (const rel of importerInvalidated) {
          store.deleteByFile(effectiveRepoName, rel);
          changed.push(rel);
        }

        filesToExtract = changed;
        const unchangedCount = files.length - changed.length;
        const importerSuffix = importerInvalidated.size > 0
          ? ` (+${importerInvalidated.size} importer(s))`
          : '';
        log(
          `  ✓ incremental: ${changed.length} changed/new${importerSuffix}, ` +
          `${unchangedCount} unchanged, ${removedFileCount} removed`,
        );
      }
    }
  }

  // 4. Project-level prelude (schema extraction).
  let schemaSummary = { systems: 0, tables: 0, columns: 0 };
  for (const plugin of plugins) {
    // Type guard: `onProjectLoaded` is optional on FrameworkPlugin.
    // The concrete plugin union from detectPlugins doesn't expose it
    // uniformly, so we check and cast at runtime.
    const hookable = plugin as { onProjectLoaded?: (ctx: ProjectContext) => import('@adorable/plugin-api').NodeBatch | Promise<import('@adorable/plugin-api').NodeBatch> };
    if (typeof hookable.onProjectLoaded === 'function') {
      const batch = await Promise.resolve(hookable.onProjectLoaded(ctx));
      store.commit(batch, makeBatchMeta(plugin.id));
      schemaSummary = {
        systems: schemaSummary.systems + batch.nodes.filter((n: { nodeType: string }) => n.nodeType === 'DatabaseSystem').length,
        tables: schemaSummary.tables + batch.nodes.filter((n: { nodeType: string }) => n.nodeType === 'DatabaseTable').length,
        columns: schemaSummary.columns + batch.nodes.filter((n: { nodeType: string }) => n.nodeType === 'DatabaseColumn').length,
      };
      log(`  ✓ ${plugin.id} schema: ${schemaSummary.systems} system(s), ${schemaSummary.tables} table(s), ${schemaSummary.columns} column(s)`);
    }
  }

  // 5. Group files by language and create language plugins.
  // Important: ALL discovered files are loaded into each language
  // plugin's Project (so cross-file resolution still works), but only
  // the `filesToExtract` subset has `extractFile` called on it under
  // `--incremental`. Unchanged files keep their existing graph data.
  const filesByLang = groupFilesByLanguage(files);
  const filesToExtractByLang = groupFilesByLanguage(filesToExtract);
  const langPlugins = createLanguagePlugins(filesByLang.keys());

  // 5a. Register framework visitors on the correct language plugin.
  //     IMPORTANT: onProjectLoaded must run BEFORE registerVisitor for
  //     plugins like Prisma whose visitor is lazy-bound to project state.
  for (const plugin of plugins) {
    const langPlugin = langPlugins.get(plugin.language);
    if (langPlugin) {
      langPlugin.registerVisitor(plugin.visitor);
    }
  }

  // 5b. Register Redux Saga/Thunk visitor for dispatch → saga handler binding.
  let reduxVisitor: import('@adorable/framework-react').ReduxVisitorWithBindings | null = null;
  if (langPlugins.has('ts') && plugins.some((p) => p.id === 'react' || p.id === 'react-native')) {
    const { createReduxVisitor } = await import('@adorable/framework-react');
    reduxVisitor = createReduxVisitor();
    langPlugins.get('ts')!.registerVisitor(reduxVisitor);
  }

  // 5c. Load projects and extract files per language.
  let totalExtracted = 0;
  for (const [lang, langPlugin] of langPlugins) {
    const langFiles = filesByLang.get(lang) ?? [];
    if (langFiles.length === 0) continue;

    const handle = await langPlugin.loadProject({
      rootDir: absRoot,
      repository: effectiveRepoName,
      ...(Object.keys(compilerPaths).length > 0 ? { compilerPaths } : {}),
      // Warnings always go to stderr — they exist precisely to
      // surface silent-failure modes (e.g., #338 cap-hit). Routing
      // them through verbose-only `log` would defeat the purpose.
      onWarning: (msg) => console.warn(`adorable analyze [${effectiveRepoName}] warning: ${msg}`),
    });
    // Under --incremental, only call extractFile on files that
    // actually changed. The full langFiles list is still loaded into
    // the project (above) so cross-file resolution sees every file.
    const langExtractList = incrementalActive
      ? (filesToExtractByLang.get(lang) ?? [])
      : langFiles;
    for (const file of langExtractList) {
      try {
        const batch = await langPlugin.extractFile(handle, file);
        store.commit(batch, makeBatchMeta(lang));
        totalExtracted++;
        // Record the new hash for incremental tracking. Errors on
        // hash compute are non-fatal — they just mean a subsequent
        // incremental run will see the file as changed again.
        // `file` is the rel-from-rootDir path that
        // `discoverSourceFiles` produces. SourceFile.filePath in the
        // graph uses the same relative-from-rootDir shape (see
        // lang-ts/extract-source-file.ts:226), so we key the hash
        // table on the same path. Need an absolute path to read
        // file bytes for the hash compute.
        if (incremental) {
          const h = computeFileHash(path.join(absRoot, file));
          if (h) store.setSourceFileHash(effectiveRepoName, file, h, SCHEMA_VERSION);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // #253 — surface heap-exhaustion as an actionable error rather
        // than a per-file warning that swallows the real cause. V8's
        // pre-OOM ENOMEM/RangeError surfaces here before the process
        // hard-aborts; we re-throw with a clearer message pointing at
        // the per-package workaround.
        // V8-canonical OOM strings only. We deliberately do NOT match
        // generic `RangeError: Maximum…` because that catches
        // "Maximum call stack size exceeded" which is a recursion bug,
        // not heap exhaustion — surfacing the OOM workaround there
        // would mislead users.
        if (/heap out of memory|out of memory|allocation failed/i.test(msg)) {
          throw new Error(
            `Heap exhausted at ${file} after extracting ${totalExtracted} files. ` +
            `Use \`adorable project init\` to generate a per-package config and run ` +
            `\`adorable project analyze\` instead — that decomposes large monorepos ` +
            `into independent ts-morph instances that fit in 8 GB. (Original: ${msg})`,
          );
        }
        log(`  skipped ${file}: ${msg}`);
      }
    }
  }
  log(`  ✓ ${totalExtracted} files extracted`);

  // 5d. Redux Saga dispatch → handler edges.
  if (reduxVisitor) {
    const dispatchEdges = reduxVisitor.getDispatchEdges();
    if (dispatchEdges.length > 0) {
      store.commit({ nodes: [], edges: dispatchEdges }, makeBatchMeta('redux-saga'));
      log(`  ✓ ${dispatchEdges.length} Redux dispatch → saga edge(s)`);
    }
  }

  // 5e. Fastify prefix composition: update endpoint routePatterns with
  //     prefix from fastify.register(plugin, { prefix: '/auth' }) calls.
  for (const plugin of plugins) {
    if (plugin.id === 'fastify') {
      const fastifyVisitor = plugin.visitor as { getPrefixMappings?: () => Array<{ prefix: string; targetSourceFileId: string; repository: string }> };
      if (typeof fastifyVisitor.getPrefixMappings === 'function') {
        const mappings = fastifyVisitor.getPrefixMappings();
        if (mappings.length > 0) {
          let composed = 0;
          const endpoints = store.findNodes('APIEndpoint');
          for (const mapping of mappings) {
            // Find all endpoints from the target source file.
            for (const ep of endpoints) {
              if (ep.framework !== 'fastify') continue;
              // Check if endpoint's evidence points to the target file.
              if (ep.evidence?.filePath) {
                const epSourceFileId = idFor.sourceFile({
                  repository: mapping.repository,
                  filePath: ep.evidence.filePath,
                });
                if (epSourceFileId === mapping.targetSourceFileId) {
                  const composedRoute = mapping.prefix + ep.routePattern;
                  // Re-commit the endpoint with the composed route.
                  // The id keeps the SAME source-location key (#185)
                  // so subsequent re-analyses are idempotent.
                  const updatedEndpoint = {
                    ...ep,
                    id: idFor.apiEndpoint({
                      repository: ep.repository,
                      httpMethod: ep.httpMethod,
                      routePattern: composedRoute,
                      filePath: ep.evidence!.filePath,
                      lineStart: ep.evidence!.lineStart,
                    }),
                    routePattern: composedRoute,
                  };
                  store.commit({ nodes: [updatedEndpoint], edges: [] }, makeBatchMeta('fastify-prefix'));
                  composed++;
                }
              }
            }
          }
          if (composed > 0) {
            log(`  ✓ composed ${composed} Fastify route prefix(es) from ${mappings.length} register() call(s)`);
          }
        }
      }
    }
  }

  // 5b. Resolve HTML inline-handler bodies to cross-file functions (#173 piece B).
  // Scans every per-process synthetic fn emitted by lang-html, parses its
  // attribute snippet for identifier calls, and emits CALLS_FUNCTION edges
  // to matching FunctionDefinitions in the same repository. Cheap walk —
  // runs even when no HTML files are present (no-op if nothing matches).
  const inlineBatch = resolveInlineHandlers(store);
  if (inlineBatch.edges.length > 0) {
    store.commit(inlineBatch, makeBatchMeta('lang-html-inline-resolver'));
    log(`  ✓ resolved ${inlineBatch.edges.length} HTML inline handler call(s) to JS functions`);
  }

  // 5c. Resolve Angular template bindings to component-class methods (#173 piece C).
  // Reads .ts files from disk to find @Component({ templateUrl }), maps each
  // template's HTML file to its component class, then emits CALLS_FUNCTION
  // edges from per-process fns to ClassName.method definitions.
  const ngBatch = resolveAngularTemplates(store, rootDir);
  if (ngBatch.edges.length > 0) {
    store.commit(ngBatch, makeBatchMeta('lang-html-angular-resolver'));
    log(`  ✓ resolved ${ngBatch.edges.length} Angular template binding(s) to component methods`);
  }

  // 5d. Resolve Rust cross-module CALLS_FUNCTION edges (#546).
  // The per-file extractor emits same-file edges only; this post-pass
  // walks .rs files, builds a project-wide symbol map keyed by
  // (modulePath, name), and resolves scoped (`orders::cancel(...)`)
  // and use-resolved bare (`cancel(...)` after `use orders::cancel;`)
  // calls into CALLS_FUNCTION edges to cross-file FunctionDefinitions.
  // Cheap walk — runs even when no Rust source is present.
  const rustBatch = resolveRustCrossModCalls(store, rootDir);
  if (rustBatch.edges.length > 0) {
    store.commit(rustBatch, makeBatchMeta('lang-rust-cross-mod-resolver'));
    log(`  ✓ resolved ${rustBatch.edges.length} Rust cross-module CALLS_FUNCTION edge(s)`);
  }

  // 5e. Merge runtime-observed trace edges (#535). Runs BEFORE the
  // stitcher so trace-emitted ClientSideAPICallers participate in
  // the same URL-pattern matching pass as statically extracted ones.
  if (opts.mergeTracePaths && opts.mergeTracePaths.length > 0) {
    const traceResult = mergeTraceFiles(store, absRoot, opts.mergeTracePaths);
    for (const missing of traceResult.missingFiles) {
      // Stderr-style warning so users notice stale --merge-trace
      // paths instead of failing silently when their JSONL went
      // missing between runs.
      console.warn(`  ⚠ trace file not found, skipping: ${missing}`);
    }
    if (traceResult.filesLoaded > 0) {
      log(
        `  ✓ merged ${traceResult.callersEmitted} runtime trace edge(s) ` +
        `(${traceResult.filesLoaded} file(s), ${traceResult.unattributable} unattributable, ` +
        `${traceResult.malformedLines} malformed line(s))`
      );
    }
  }

  // 6. Stitch callers to endpoints (respects stitchMode).
  let resolvedCount = 0;
  const allCallers = store.findNodes('ClientSideAPICaller');
  const dynamicCount = allCallers.filter(
    (c) => c.urlLiteral === null || c.egressConfidence === 'dynamic'
  ).length;

  // Discover proxy rules for this repo (#188). When the orchestrator
  // already aggregated rules across the project, prefer those — they
  // include sibling repos' configs that affect cross-repo stitching.
  const proxyRules = opts.proxyRules ?? discoverProxyRules(absRoot);
  if (proxyRules.length > 0) {
    log(`  ✓ discovered ${proxyRules.length} proxy rule(s) from build configs`);
  }

  const stitchOpts = { proxyRules, applicationScope: opts.applicationScope };
  if (stitchMode === 'none') {
    log(`  ○ stitching skipped (--stitch-mode none). Use MCP tools to stitch interactively.`);
  } else if (stitchMode === 'auto-all') {
    // v1 behavior: stitch everything
    const stitchBatch = stitchStore(store, stitchOpts);
    store.commit(stitchBatch, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));
    resolvedCount = stitchBatch.edges.length;
    log(`  ✓ stitched (auto-all): ${resolvedCount} resolved, ${dynamicCount} dynamic (deferred)`);
  } else {
    // auto-exact: stitch only deterministic matches (high confidence)
    const stitchBatch = stitchStore(store, stitchOpts);
    // Filter to only high-confidence edges
    const highConfEdges = stitchBatch.edges.filter((e) => {
      if (e.edgeType !== 'RESOLVES_TO_ENDPOINT') return false;
      return (e as { matchConfidence?: string }).matchConfidence === 'high';
    });
    if (highConfEdges.length > 0) {
      store.commit({ nodes: [], edges: highConfEdges }, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));
    }
    resolvedCount = highConfEdges.length;
    const skippedCount = stitchBatch.edges.length - highConfEdges.length;
    log(`  ✓ stitched (auto-exact): ${resolvedCount} deterministic, ${skippedCount} skipped (use MCP tools to review), ${dynamicCount} dynamic`);
  }

  // 7. Walk flows.
  const walker = createFlowWalker(store, { maxCallDepth });
  const flows = walker.walkAllProcesses();
  const completeFlowCount = flows.filter((f) => f.completeness === 'complete').length;
  const partialFlowCount = flows.length - completeFlowCount;
  log(`  ✓ ${completeFlowCount} complete flow(s), ${partialFlowCount} partial`);

  const emittingPlugins = computeEmittingPlugins(store, pluginIds);
  const silentPlugins = pluginIds.filter((id) => !emittingPlugins.includes(id));
  if (silentPlugins.length > 0) {
    log(`  ✓ emitting plugins: ${emittingPlugins.join(', ') || 'none'} (silent: ${silentPlugins.join(', ')})`);
  }

  return {
    rootDir: absRoot,
    sourceFileCount: files.length,
    detectedPlugins: pluginIds,
    emittingPlugins,
    schemaSummary,
    stitchSummary: { resolved: resolvedCount, dynamic: dynamicCount },
    flows,
    completeFlowCount,
    partialFlowCount,
    store,
  };
}

/**
 * Walk the committed graph and return the subset of `detectedPlugins`
 * that actually contributed nodes (#523 item 3). A plugin is
 * "emitting" if any node in the graph carries its id in a
 * provenance field — `framework`, `orm`, or a per-plugin prefix
 * (e.g. `bundler-vite` → `bundler`). Plugins in `detectedPlugins`
 * but not in the result are activated-but-silent.
 *
 * This is a post-process pass rather than per-emit instrumentation
 * because lang-ts reuses a single `TsVisitContext` across all
 * visitors for a file (see framework-visitor.ts) — wrapping the
 * context's emit methods per-plugin would either race with other
 * visitors or require per-call Proxy allocation. Scanning the final
 * graph is O(N) over committed nodes and runs once at the end.
 */
function computeEmittingPlugins(
  store: SQLiteCanonicalGraphStore,
  detectedPluginIds: readonly string[],
): string[] {
  const witnesses = new Set<string>();
  // Map of node types whose framework / orm / kind fields carry
  // plugin-id provenance. We list these explicitly rather than
  // walking every node type so the contract is auditable.
  const sources: Array<{ nodeType: Parameters<typeof store.findNodes>[0]; fields: string[] }> = [
    { nodeType: 'APIEndpoint', fields: ['framework'] },
    { nodeType: 'ClientSideAPICaller', fields: ['framework'] },
    { nodeType: 'ClientSideProcess', fields: ['framework'] },
    { nodeType: 'Screen', fields: ['framework'] },
    { nodeType: 'DatabaseInteraction', fields: ['orm'] },
    { nodeType: 'DatabaseSystem', fields: ['kind'] },
  ];
  for (const { nodeType, fields } of sources) {
    let nodes: Array<Record<string, unknown>>;
    try {
      nodes = store.findNodes(nodeType) as unknown as Array<Record<string, unknown>>;
    } catch {
      continue;
    }
    for (const n of nodes) {
      for (const f of fields) {
        const v = n[f];
        if (typeof v === 'string' && v.length > 0) witnesses.add(v);
      }
    }
  }
  // Map emission witnesses to plugin ids where the strings don't
  // line up directly. Most plugins emit `framework: '<plugin.id>'`,
  // but a handful use language-flavored or per-service tags. Listed
  // explicitly so the contract is auditable from one place.
  const aliasedWitnesses = new Set(witnesses);
  for (const w of witnesses) {
    if (w.startsWith('bundler-')) aliasedWitnesses.add('bundler');
    if (w.startsWith('boto3-')) aliasedWitnesses.add('boto3');
    if (w.startsWith('awsgo-')) aliasedWitnesses.add('awsgo-s3');
    if (w.startsWith('awsrust-')) aliasedWitnesses.add('awsrust-s3');
    // framework-aws-s3-ts is the umbrella plugin for the AWS SDK v3
    // client-* family (#284). Its visitor emits `framework=aws-X-ts`
    // for each service (s3/dynamodb/sqs/sns/lambda). A project that
    // only uses, say, DynamoDB still has the aws-s3-ts plugin
    // emitting nodes — keep it in the emitting set.
    if (w.startsWith('aws-') && w.endsWith('-ts')) aliasedWitnesses.add('aws-s3-ts');
    if (w.endsWith('-ssr')) aliasedWitnesses.add(w.slice(0, -'-ssr'.length));
  }
  // Language-flavored CLI plugins emit `framework: 'python'/'go'/'rust'`.
  for (const [framework, pluginId] of [
    ['python', 'pycli'],
    ['go', 'gocli'],
    ['rust', 'rustcli'],
    ['cobra', 'gocli'],
    ['tauri', 'rustcli'],
    // framework-state-mgmt is one plugin that emits per-library
    // witnesses (redux/mobx/zustand/pinia/redux-saga) plus the
    // canonical `state-mgmt`. Any per-library witness keeps the
    // plugin in the emitting set.
    ['redux', 'state-mgmt'],
    ['redux-saga', 'state-mgmt'],
    ['mobx', 'state-mgmt'],
    ['zustand', 'state-mgmt'],
    ['pinia', 'state-mgmt'],
  ] as const) {
    if (witnesses.has(framework)) aliasedWitnesses.add(pluginId);
  }
  return detectedPluginIds.filter((id) => aliasedWitnesses.has(id));
}

/**
 * #294 Phase 2a — content hash for a source file. sha256 over the
 * raw bytes; collisions are negligibly improbable. Returns null on
 * unreadable files (caller treats those as changed so the rest of
 * the pipeline gets a chance to surface the real error).
 */
function computeFileHash(absPath: string): string | null {
  try {
    const bytes = fs.readFileSync(absPath);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}
