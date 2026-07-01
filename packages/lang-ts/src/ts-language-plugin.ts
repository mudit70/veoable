import * as path from 'node:path';
import * as fs from 'node:fs';
import { Project, ts } from 'ts-morph';
import type { NodeBatch } from '@veoable/schema';
import type { FrameworkVisitor, LanguagePlugin, ProjectHandle, ProjectOptions } from '@veoable/plugin-api';
import { withSpan } from '@veoable/observability';
import { extractSourceFile } from './extract-source-file.js';
import { unwrapHandle, wrapHandle, type TsProjectInternal } from './project-handle.js';
import type { TsFrameworkVisitor } from './framework-visitor.js';

export const TS_PLUGIN_ID = 'ts' as const;

export const TS_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * Foundational TypeScript language plugin (#36).
 *
 * In this PR (part 1/3) the plugin emits the structural layer of the
 * call graph: `SourceFile`, `FunctionDefinition`, `IMPORTS`, `EXPORTS`,
 * and `DEFINED_IN`. The actual `CALLS_FUNCTION` edges land in PR 2; the
 * framework visitor hook lands in PR 3.
 *
 * Design contract:
 *  - One language plugin per language. This one claims `.ts/.tsx/.js/
 *    .jsx/.mjs/.cjs`.
 *  - Plugins emit `NodeBatch` values; they never write to the graph
 *    store directly.
 *  - All node ids go through `idFor.*` from `@veoable/schema`.
 *  - All extraction work is wrapped in `withSpan` so a debugger can see
 *    which file took how long and which decisions were made.
 */
export class TsLanguagePlugin implements LanguagePlugin {
  readonly id = TS_PLUGIN_ID;
  readonly fileExtensions = TS_FILE_EXTENSIONS;

  /**
   * Framework visitors registered via `registerVisitor`. Dispatched
   * once per AST node during `extractFile`. Order of registration is
   * preserved; visitors run in the order they were registered.
   */
  private readonly visitors: TsFrameworkVisitor[] = [];

  /**
   * #253 — bounded LRU window of recently-extracted source files. When
   * the env var `ADORABLE_LANG_TS_MAX_PARSED_FILES` is set to a
   * positive integer N, `extractFile` keeps at most N most-recent
   * SourceFile ASTs in the ts-morph Project; older ones get
   * `forget()`-ed to release the AST + symbol info.
   *
   * Tradeoff: framework plugins that walk back through cross-file
   * symbol resolution (framework-prisma's receiver resolver,
   * framework-typeorm's @Entity discovery, framework-mikroorm's
   * EntityRepository resolution) may produce reduced direct-DBI
   * coverage when their resolution chases a forgotten file. The
   * `project analyze` command remains the recommended path for
   * large monorepos — it scopes per-subpackage so each scope's
   * Project is small enough to fit in memory and gets fully released
   * between scopes.
   *
   * Defaults to `null` (no LRU; legacy behavior; no risk of
   * cross-file resolution regression).
   */
  private readonly lruWindow: string[] = [];
  // Env var is read once at construction. Tests that need a different
  // limit must construct a fresh `TsLanguagePlugin` after mutating
  // `process.env`.
  private readonly lruLimit: number | null = (() => {
    const raw = process.env.ADORABLE_LANG_TS_MAX_PARSED_FILES;
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  async loadProject(opts: ProjectOptions): Promise<ProjectHandle> {
    return withSpan('lang-ts.loadProject', { 'project.rootDir': opts.rootDir }, async () => {
      const rootDir = path.resolve(opts.rootDir);

      // Convert the orchestrator-supplied `compilerPaths` (synthesized
      // from monorepo workspace metadata, see #195) into ts-morph's
      // mutable Record shape. We avoid touching user-declared `paths`
      // when a tsconfig is present and itself has a `paths` config —
      // those are the source of truth and override our synthesized
      // entries on key collision.
      const synthesizedPaths = opts.compilerPaths
        ? Object.fromEntries(
            Object.entries(opts.compilerPaths).map(([k, v]) => [k, [...v]]),
          )
        : undefined;

      const tsconfigPath = locateTsconfig(rootDir);
      let project: Project;
      if (tsconfigPath) {
        project = new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: false });
        // ts-morph requires `baseUrl` to be set for `paths` to take
        // effect during module resolution. tsconfig.json files often
        // omit `baseUrl` because newer TS resolution modes (`bundler`,
        // `node16`, `nodenext`) treat `paths` as relative to the
        // tsconfig's own directory — but ts-morph still needs the
        // explicit value to wire up the resolver.
        //
        // Without this, `getModuleSpecifierSourceFile()` returns null
        // for any path-aliased import (`@/lib/prisma`,
        // `~/utils`, …), which silently breaks cross-file resolution
        // in framework plugins. #312, root-caused after PR #309
        // shipped a name-regex fallback band-aid.
        const loadedOpts = project.getCompilerOptions();
        const hasOwnPaths = loadedOpts.paths && Object.keys(loadedOpts.paths).length > 0;
        if (synthesizedPaths || (hasOwnPaths && !loadedOpts.baseUrl)) {
          const existing = loadedOpts.paths ?? {};
          const merged: Record<string, string[]> = synthesizedPaths
            ? { ...synthesizedPaths, ...Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, [...v]])) }
            : Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, [...v]]));
          project.compilerOptions.set({
            paths: merged,
            baseUrl: loadedOpts.baseUrl ?? path.dirname(tsconfigPath),
          });
        }
      } else {
        project = new Project({
          compilerOptions: {
            allowJs: true,
            checkJs: false,
            noEmit: true,
            esModuleInterop: true,
            skipLibCheck: true,
            ...(synthesizedPaths ? { paths: synthesizedPaths, baseUrl: rootDir } : {}),
          },
        });
      }

      // Sweep the rootDir to pick up files outside the root tsconfig's
      // `include` — but only when needed. Monorepos with per-app /
      // per-package tsconfigs (typebot.io, dub, papermark, …) rely on
      // this: the root tsconfig either has no `include` for subpackage
      // source dirs or uses `references` to delegate to sub-tsconfigs
      // that ts-morph doesn't follow. Without the sweep, every TS/TSX
      // file under `apps/*` and `packages/*` gets dropped at
      // `extractFile` with a "file was not loaded into the project"
      // warning — the entire monorepo silently produces an empty
      // graph (#529).
      //
      // Gating matters for performance. Repos whose root tsconfig
      // already covers everything (cal.com is the canonical example
      // at 6803 files) get 10x slower if we sweep unconditionally,
      // since ts-morph adds source files it then has to AST-parse
      // even when they produce no graph nodes. We sweep only when
      //   (a) opts.include was supplied by the orchestrator
      //       (explicit intent — honor it), OR
      //   (b) there is no tsconfig at all (fallback discovery), OR
      //   (c) we detect a monorepo whose subpackages have their own
      //       tsconfigs that the root tsconfig doesn't reach.
      //
      // `addSourceFilesAtPaths` deduplicates against existing files
      // in the Project, so files already loaded via the tsconfig
      // include don't get re-added.
      //
      // Two known limitations, both acceptable for now:
      //   - The sweep does not honor the root tsconfig's `exclude`
      //     array. A user with `exclude: ["src/legacy/**"]` will see
      //     those files re-pulled in. Filed as a follow-up.
      //   - Files swept in inherit the root tsconfig's
      //     compilerOptions, not their per-package tsconfig's. We
      //     never typecheck, so `strict` / `noImplicitAny` drift
      //     doesn't affect the graph; AST shape is the same.
      const shouldSweep =
        opts.include !== undefined ||
        !tsconfigPath ||
        hasMonorepoSubpackageTsconfigs(rootDir, tsconfigPath) ||
        isProjectReferencesShellTsconfig(tsconfigPath);
      if (shouldSweep) {
        const include = opts.include ?? defaultGlobsForExtensions(rootDir);
        // ts-morph's glob matcher requires exclusion patterns to share
        // the same absolute-vs-relative shape as the include globs.
        // `defaultGlobsForExtensions` produces absolute `<rootDir>/**/*`
        // patterns, so we anchor the exclusions to rootDir too.
        const exclude = opts.exclude ?? [
          path.join(rootDir, '**/node_modules/**'),
          path.join(rootDir, '**/dist/**'),
        ];
        project.addSourceFilesAtPaths([...include, ...exclude.map((p) => '!' + p)]);
      }

      // #325 — load source files from path-mapped targets too. When
      // the orchestrator supplies cross-package `paths` (synthesized
      // from the workspace's siblings), each target directory's
      // sources need to be in the project so ts-morph's
      // `getModuleSpecifierSourceFile()` can resolve them. Without
      // this, per-repo analyses see the alias mapping but not the
      // file behind it.
      //
      // Bounded by MAX_EXTRA_PATH_TARGETS to avoid quadratic loading
      // in large monorepos. The original cap of 30 was set during
      // initial cross-package work but turns out to be too low for
      // real Prisma-using monorepos:
      //   cal.com   — 115 unique path targets
      //   typebot.io — 76 unique path targets
      //   dub       — 67 unique path targets
      // At 30 the cap dropped critical siblings (including each
      // repo's `@<scope>/prisma` package), forcing direct DBI counts
      // to zero on consumer sub-repos (#325).
      //
      // 250 covers every OSS repo we test against today with
      // headroom for medium-sized internal monorepos. Truly huge
      // codebases (nx repos with 500+ packages) can override via
      // ADORABLE_MAX_EXTRA_PATH_TARGETS — both directions are safe
      // (a lower value trades coverage for cold-start time on
      // overwhelming workspaces).
      const envOverride = Number(process.env.ADORABLE_MAX_EXTRA_PATH_TARGETS);
      const MAX_EXTRA_PATH_TARGETS = Number.isFinite(envOverride) && envOverride > 0
        ? Math.floor(envOverride)
        : 250;
      const allPaths = project.getCompilerOptions().paths ?? {};
      const seen = new Set<string>();
      const rootDirWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
      let loadedCount = 0;
      let capHit = false;
      outer: for (const [, targets] of Object.entries(allPaths)) {
        for (const t of targets) {
          if (loadedCount >= MAX_EXTRA_PATH_TARGETS) {
            capHit = true;
            break outer;
          }
          const stripped = t.replace(/\/\*$/, '');
          const baseUrl = project.getCompilerOptions().baseUrl ?? rootDir;
          const abs = path.isAbsolute(stripped) ? stripped : path.resolve(baseUrl, stripped);
          if (seen.has(abs)) continue;
          seen.add(abs);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
          // Skip the project root itself (already loaded) AND any
          // descendant of rootDir (also already loaded by tsconfig
          // include or the no-tsconfig glob fallback above).
          const absWithSep = abs.endsWith(path.sep) ? abs : abs + path.sep;
          if (abs === rootDir) continue;
          if (rootDir.startsWith(absWithSep)) continue; // abs is an ancestor of rootDir
          if (abs.startsWith(rootDirWithSep)) continue; // abs is inside rootDir
          try {
            project.addSourceFilesAtPaths([
              ...TS_FILE_EXTENSIONS.map((ext) => path.join(abs, '**/*' + ext)),
              '!' + path.join(abs, '**/node_modules/**'),
              '!' + path.join(abs, '**/dist/**'),
            ]);
            loadedCount++;
          } catch {
            // Best-effort; ignore unreadable directories.
          }
        }
      }
      if (capHit && opts.onWarning) {
        // Report the absolute counts rather than a derived "skipped"
        // number. Targets dropped for unrelated reasons (descendants
        // of rootDir, nonexistent dirs, etc.) reduce `loadedCount`
        // without consuming a cap slot, so `total - loadedCount`
        // would overstate the capped portion.
        const totalUnique = countUniquePathTargets(allPaths);
        opts.onWarning(
          `lang-ts: cross-package path-target loader hit cap (${MAX_EXTRA_PATH_TARGETS}) ` +
            `before walking all ${totalUnique} unique path targets. ` +
            'If cross-package imports from a later package fail to resolve, ' +
            'this cap is the likely cause — file an issue with the path-count.',
        );
      }

      const internal: TsProjectInternal = {
        project,
        rootDir,
        repository: opts.repository ?? path.basename(rootDir),
      };
      return wrapHandle(internal);
    });
  }

  async extractFile(handle: ProjectHandle, filePath: string): Promise<NodeBatch> {
    return withSpan(
      'lang-ts.extractFile',
      { 'file.path': filePath },
      async (): Promise<NodeBatch> => {
        const internal = unwrapHandle(handle);
        const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(internal.rootDir, filePath);
        const sourceFile = internal.project.getSourceFile(absolute);
        if (!sourceFile) {
          throw new Error(
            `@veoable/lang-ts: extractFile called for '${filePath}' but the file was not loaded into the project. ` +
              'Make sure loadProject was called with a rootDir that contains it.'
          );
        }
        const result = extractSourceFile(internal, sourceFile, this.visitors);
        // #253 — bounded LRU eviction (opt-in via env var). Drops the
        // AST of the oldest file once the window exceeds `lruLimit`.
        // Skipped when `lruLimit` is null (default) so legacy behavior
        // is preserved.
        if (this.lruLimit !== null) {
          this.evictLruIfNeeded(internal, absolute);
        }
        return { nodes: result.nodes, edges: result.edges };
      }
    );
  }

  /**
   * #253 — push `absolute` onto the LRU and forget any SourceFile that
   * falls outside the window. Called once per `extractFile` when the
   * LRU is enabled.
   */
  private evictLruIfNeeded(internal: TsProjectInternal, absolute: string): void {
    if (this.lruLimit === null) return;
    // Bring file to the tail (most-recent end). `push` extends the
    // tail; `shift` evicts from the head (oldest).
    const existingIdx = this.lruWindow.indexOf(absolute);
    if (existingIdx >= 0) this.lruWindow.splice(existingIdx, 1);
    this.lruWindow.push(absolute);

    while (this.lruWindow.length > this.lruLimit) {
      const evict = this.lruWindow.shift();
      if (!evict) break;
      const sf = internal.project.getSourceFile(evict);
      if (sf) sf.forget();
    }
  }

  /**
   * Register a framework visitor. Visitors must target this language
   * (`visitor.language === 'ts'`) and must implement `onNode`. Anything
   * else is rejected with a clear error so mis-wired plugins fail loud
   * at startup rather than silently dropping emissions.
   */
  registerVisitor(visitor: TsFrameworkVisitor): void;
  registerVisitor(visitor: FrameworkVisitor): void;
  registerVisitor(visitor: FrameworkVisitor | TsFrameworkVisitor): void {
    if (visitor.language !== TS_PLUGIN_ID) {
      throw new Error(
        `@veoable/lang-ts: cannot register visitor for language '${visitor.language}'; ` +
          `this plugin only accepts visitors with language: '${TS_PLUGIN_ID}'.`
      );
    }
    if (typeof (visitor as TsFrameworkVisitor).onNode !== 'function') {
      throw new Error(
        `@veoable/lang-ts: visitor is missing the required onNode(ctx, node) method.`
      );
    }
    this.visitors.push(visitor as TsFrameworkVisitor);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function locateTsconfig(rootDir: string): string | null {
  // Prefer `tsconfig.json` (canonical name). Fall back to
  // `tsconfig.base.json` (Nx/Lerna/Turborepo convention used by
  // ghostfolio, cal.com, formbricks, etc.) when the canonical name
  // isn't present — without this, monorepo path-alias mappings are
  // never seen by ts-morph and cross-package import resolution
  // silently fails.
  for (const name of ['tsconfig.json', 'tsconfig.base.json']) {
    const candidate = path.join(rootDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function countUniquePathTargets(
  paths: Readonly<Record<string, readonly string[]>>,
): number {
  const seen = new Set<string>();
  for (const targets of Object.values(paths)) {
    for (const t of targets) seen.add(t.replace(/\/\*$/, ''));
  }
  return seen.size;
}

function defaultGlobsForExtensions(rootDir: string): string[] {
  return TS_FILE_EXTENSIONS.map((ext) => path.join(rootDir, '**/*' + ext));
}

/**
 * Detect monorepos whose subpackages carry their own tsconfigs and
 * are NOT reached by the root tsconfig — the case that #529 cares
 * about. Scans `apps/`, `packages/`, and `services/` (the three
 * conventional layouts: NextJS/Turborepo, pnpm/yarn workspaces, and
 * Nx-style services).
 *
 * Returns true as soon as it finds a subpackage tsconfig that the
 * root tsconfig's `references` array does NOT list. If the root
 * tsconfig already references the subpackage, ts-morph's tsconfig
 * load handles the file inclusion and the sweep would only add cost.
 */
/**
 * Detect the TypeScript project-references "shell" pattern: a root
 * `tsconfig.json` that delegates entirely via `references` and covers
 * no files itself (`files: []` and no `include`). This is the default
 * shape emitted by Vite templates, `create-react-app --template
 * typescript`, and any repo that follows the TS Handbook's
 * project-references guide.
 *
 * ts-morph loads the shell tsconfig but does not walk its `references`,
 * so without a filesystem sweep the resulting Project is empty and
 * every downstream `extractFile` call throws "file was not loaded into
 * the project". #15, root-caused after `analyze` produced 0 flows on
 * trade-unison (Vite + React + Supabase, 282 files) despite the
 * framework visitors being wired up correctly.
 */
function isProjectReferencesShellTsconfig(rootTsconfigPath: string): boolean {
  try {
    const raw = fs.readFileSync(rootTsconfigPath, 'utf8');
    const result = ts.parseConfigFileTextToJson(rootTsconfigPath, raw);
    if (result.error || result.config === undefined) return false;
    const parsed = result.config as {
      references?: unknown[];
      files?: unknown[];
      include?: unknown[];
    };
    const hasReferences = Array.isArray(parsed.references) && parsed.references.length > 0;
    if (!hasReferences) return false;
    const hasInclude = Array.isArray(parsed.include) && parsed.include.length > 0;
    if (hasInclude) return false;
    const hasFiles = Array.isArray(parsed.files) && parsed.files.length > 0;
    if (hasFiles) return false;
    return true;
  } catch {
    return false;
  }
}

function hasMonorepoSubpackageTsconfigs(rootDir: string, rootTsconfigPath: string): boolean {
  const referencedPaths = new Set<string>();
  try {
    const raw = fs.readFileSync(rootTsconfigPath, 'utf8');
    // Use TypeScript's own JSONC parser — tsconfigs routinely contain
    // `//` line comments and trailing commas that a JSON.parse + regex
    // strip mis-handles (it would clobber `//` inside string values
    // like `"path": "https://…"`).
    const result = ts.parseConfigFileTextToJson(rootTsconfigPath, raw);
    if (result.error || result.config === undefined) {
      // Malformed tsconfig — sweep is the safer fallback.
      return true;
    }
    const parsed = result.config as { references?: Array<{ path?: string }> };
    for (const ref of parsed.references ?? []) {
      if (typeof ref?.path === 'string') {
        referencedPaths.add(path.resolve(path.dirname(rootTsconfigPath), ref.path));
      }
    }
  } catch {
    return true;
  }
  // Conventional monorepo layout dirs. `libs/` is the Nx default;
  // `apps/`, `packages/`, `services/` cover Turborepo / pnpm / Nx-style.
  // Repos that bury tsconfigs elsewhere fall through and miss the
  // sweep — documented limitation.
  for (const dirName of ['apps', 'packages', 'services', 'libs']) {
    const dir = path.join(rootDir, dirName);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subTsconfig = path.join(dir, entry.name, 'tsconfig.json');
      if (!fs.existsSync(subTsconfig)) continue;
      const subDir = path.join(dir, entry.name);
      // `references` may name the directory OR the tsconfig file
      // directly (TypeScript supports both). Both forms match here.
      if (referencedPaths.has(subDir) || referencedPaths.has(subTsconfig)) continue;
      return true;
    }
  }
  return false;
}
