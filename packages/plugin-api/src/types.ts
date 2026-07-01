/**
 * Opaque handle types shared by language and framework plugins.
 *
 * These are runtime-opaque: plugins cannot forge them because the brand is
 * a unique symbol only visible inside the language plugin that produced the
 * handle. This keeps the "plugins never touch internal parser state" rule
 * enforceable at the type level.
 */

declare const projectHandleBrand: unique symbol;

/**
 * An opaque handle to a loaded project (ts-morph Project, Pyright server,
 * go/packages Load result, etc.). Produced by `LanguagePlugin.loadProject`
 * and passed back into `LanguagePlugin.extractFile`. Consumers must never
 * construct one directly.
 */
export interface ProjectHandle {
  readonly [projectHandleBrand]: true;
}

/**
 * Options passed to `LanguagePlugin.loadProject`. Intentionally minimal —
 * language plugins add their own options via intersection types when they
 * need them.
 */
export interface ProjectOptions {
  /** Absolute path to the project root. */
  rootDir: string;
  /** Override the repository name (default: derived from rootDir basename). */
  repository?: string;
  /**
   * Optional list of relative globs restricting which files the plugin
   * considers part of the project (defaults to the plugin's `fileExtensions`).
   */
  include?: readonly string[];
  /** Optional list of relative globs to exclude. */
  exclude?: readonly string[];
  /**
   * Compiler module-resolution `paths` map injected into the language
   * plugin's parser (e.g. ts-morph `compilerOptions.paths`). Synthesized
   * by the orchestrator from monorepo workspace metadata so that
   * cross-package alias imports (`@scope/pkg/...` resolving to a
   * sibling subpackage in the same workspace) succeed without the user
   * having to run `pnpm install` first (#195).
   *
   * Shape mirrors tsconfig's `paths`:
   *   `{ "@scope/pkg": ["/abs/path/to/pkg"], "@scope/pkg/*": ["/abs/path/to/pkg/*"] }`
   *
   * Language plugins MAY merge this with a tsconfig's existing `paths`
   * (root-declared paths win on collision).
   */
  compilerPaths?: Readonly<Record<string, readonly string[]>>;
  /**
   * Optional sink for non-fatal warnings emitted during project load
   * — e.g. when a resource-limit cap is reached and silently dropping
   * later inputs would degrade analysis quality. The orchestrator
   * typically wires this through to the CLI's verbose progress
   * stream. When omitted, warnings are silently dropped.
   */
  onWarning?: (message: string) => void;
}

/**
 * One parsed `package.json` manifest at a known location in the
 * project tree. The orchestrator collects these from the root and
 * every subdirectory (excluding `node_modules`, build outputs, etc.).
 *
 * Monorepos commonly keep framework dependencies in subpackage
 * manifests (e.g. `server/package.json` declares `express`, the root
 * has only build-tooling). Plugins that scan `manifests` activate
 * correctly across this layout instead of silently missing because
 * the root doesn't list the dep (#184).
 */
export interface ManifestRecord {
  /** Relative path from `rootDir` to the directory holding this manifest. */
  relPath: string;
  /** Parsed manifest contents. */
  packageJson: Record<string, unknown>;
}

/**
 * Per-ecosystem manifest record (#203). Mirrors `ManifestRecord` but
 * carries a normalized `dependencies` map regardless of source format
 * (requirements.txt vs pyproject.toml vs Pipfile, pom.xml vs
 * build.gradle, etc.). Plugins use the helper functions in
 * `manifest-helpers.ts` rather than reading these directly.
 */
export interface DependencyManifestRecord {
  /** Relative path from `rootDir` to the directory holding this manifest. */
  relPath: string;
  /** Manifest filename (e.g. `requirements.txt`, `pom.xml`). */
  source: string;
  /**
   * Dependency name → version string (best-effort; "*" when no version
   * specifier was extractable). Names are normalized to canonical
   * form for the ecosystem (e.g. lowercase for Python).
   */
  dependencies: Record<string, string>;
}

/**
 * Context passed to `FrameworkPlugin.appliesTo` so a framework plugin can
 * decide whether the current project uses the framework it detects for.
 * Populated by the orchestrator from repo-level metadata.
 */
export interface ProjectContext {
  /** Absolute path to the project root. */
  rootDir: string;
  /**
   * Absolute path to the OUTER workspace root, when `rootDir` is a
   * sub-repo inside a monorepo (#334). For single-repo projects this
   * is undefined or equal to `rootDir`. Plugins that need to discover
   * shared resources across sibling packages (Prisma schemas,
   * monorepo-level tsconfig, etc.) should consult this in addition
   * to `rootDir`. Synthesized by the CLI's `project analyze` from the
   * project config file's directory.
   */
  workspaceRoot?: string;
  /**
   * Parsed `package.json` contents if present, else null. The
   * orchestrator synthesizes the `dependencies` / `devDependencies` /
   * `peerDependencies` fields here as the union across the root
   * manifest *and* every subpackage manifest in `manifests`, so
   * existing plugins that just check
   * `ctx.packageJson?.dependencies?.[name]` activate correctly on
   * monorepos without needing to walk subpackages themselves (#184).
   * Other top-level fields (name, scripts, etc.) come from the root
   * manifest only.
   */
  packageJson: Record<string, unknown> | null;
  /**
   * Every parsed `package.json` discovered under `rootDir` (recursive,
   * excluding common non-source directories). The root manifest, if
   * present, is always the first entry (`relPath === '.'`). Plugins
   * needing per-subpackage granularity (e.g. "is Express used on the
   * backend specifically?") can iterate this list.
   *
   * Optional for backward compatibility with callers that build a
   * `ProjectContext` literal without invoking the orchestrator's
   * `buildProjectContext` (e.g. unit tests). Treat absent as `[]`.
   */
  manifests?: readonly ManifestRecord[];
  /**
   * Per-ecosystem dependency manifests discovered under `rootDir` (#203).
   * Same monorepo-walking shape as `manifests`, but for non-JS
   * languages. Each ecosystem has its own normalized `dependencies`
   * map keyed by canonical package name; use the `hasPythonPackage` /
   * `hasGoModule` / `hasMavenArtifact` / `hasComposerPackage` /
   * `hasCargoCrate` helpers in `manifest-helpers.ts` rather than
   * scanning these directly.
   *
   * Each field is optional for backward compatibility; treat absent
   * as `[]`.
   */
  pythonManifests?: readonly DependencyManifestRecord[];
  goManifests?: readonly DependencyManifestRecord[];
  javaManifests?: readonly DependencyManifestRecord[];
  phpManifests?: readonly DependencyManifestRecord[];
  rustManifests?: readonly DependencyManifestRecord[];
  /**
   * Relative file paths of project files the orchestrator has discovered.
   * Framework plugins may use this to detect convention-based markers
   * (e.g. Next.js plugin checks for a `pages/` or `app/` directory).
   */
  files: readonly string[];
  /**
   * Orchestrator-supplied pre-discoveries, keyed by framework-plugin
   * id. The orchestrator (CLI's `project analyze`) walks the
   * workspace once per analysis run and stashes the result here so
   * per-repo plugin instances reuse it instead of each re-scanning
   * (#344). Initial consumer: `'prisma'` → list of absolute paths to
   * canonical schemas. Other plugins (Drizzle, TypeORM, OpenAPI,
   * etc.) may add their own keys as their orchestrators land.
   *
   * Tri-state semantics per key:
   *   - key absent (or whole field absent) → orchestrator did NOT
   *     scan for this plugin; the plugin should fall back to its
   *     own scan.
   *   - key present with `[]` → orchestrator scanned and found
   *     nothing; the plugin should trust that and NOT fall back.
   *   - key present with non-empty list → use these paths.
   *
   * Plugins consuming this field should namespace by their own id
   * (`ctx.frameworkDiscoveries?.[PRISMA_PLUGIN_ID]`).
   */
  frameworkDiscoveries?: Readonly<Record<string, readonly string[]>>;
}
