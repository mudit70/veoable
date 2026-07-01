import type { DependencyManifestRecord, ManifestRecord, ProjectContext } from './types.js';

/**
 * Helpers for inspecting `ProjectContext.manifests` from a framework
 * plugin's `appliesTo()`. Most plugins can keep using
 * `ctx.packageJson?.dependencies?.[name]` (the orchestrator merges
 * subpackage deps into that field), but plugins that need to know
 * *which* manifest declares a dependency — e.g. to attach
 * subpackage-aware emission rules — can use these.
 */

/**
 * Returns true if any manifest in `ctx` declares the dependency
 * `name` in `dependencies`, `devDependencies`, or `peerDependencies`.
 *
 * This is the canonical activation check for framework plugins on
 * monorepos: it works whether the dep lives in the root manifest, a
 * subpackage manifest, or both. Equivalent to checking
 * `ctx.packageJson?.dependencies?.[name]` in single-package projects
 * (the merged dependencies field on `packageJson` is computed for
 * exactly this convenience).
 */
export function hasDependency(ctx: ProjectContext, name: string): boolean {
  const merged = ctx.packageJson;
  if (merged && dependencyIn(merged, name)) return true;
  for (const m of ctx.manifests ?? []) {
    if (dependencyIn(m.packageJson, name)) return true;
  }
  return false;
}

/**
 * Returns the subset of `ctx.manifests` that declare `name` as a
 * dependency. Useful when a plugin wants to know which subpackage(s)
 * a framework lives in (e.g. to scope its visitors).
 */
export function manifestsDeclaring(
  ctx: ProjectContext,
  name: string,
): readonly ManifestRecord[] {
  return (ctx.manifests ?? []).filter((m) => dependencyIn(m.packageJson, name));
}

function dependencyIn(pkg: Record<string, unknown>, name: string): boolean {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object' && name in (deps as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Per-ecosystem dependency helpers (#203)
// ──────────────────────────────────────────────────────────────────────

/**
 * Returns true if `name` (or a regex matching the dep name) appears
 * in any of the project's Python manifests (`requirements.txt`,
 * `pyproject.toml`, `Pipfile`, etc.). Names are matched case-
 * insensitively; PEP 503 normalization (replacing `_`/`.` with `-`)
 * is applied to both the query and the manifest names so common
 * variants match.
 */
export function hasPythonPackage(ctx: ProjectContext, name: string | RegExp): boolean {
  return manifestMatches(ctx.pythonManifests, name, normalizePythonName);
}

export function hasGoModule(ctx: ProjectContext, name: string | RegExp): boolean {
  return manifestMatches(ctx.goManifests, name, (n) => n);
}

/**
 * Maven coordinates are `groupId:artifactId`. The `name` query can be
 * either a full coordinate or just an artifactId; both shapes are
 * supported. Helper checks for substring match against
 * `groupId:artifactId` keys.
 */
export function hasMavenArtifact(ctx: ProjectContext, name: string | RegExp): boolean {
  return manifestMatches(ctx.javaManifests, name, (n) => n);
}

export function hasComposerPackage(ctx: ProjectContext, name: string | RegExp): boolean {
  return manifestMatches(ctx.phpManifests, name, (n) => n);
}

export function hasCargoCrate(ctx: ProjectContext, name: string | RegExp): boolean {
  return manifestMatches(ctx.rustManifests, name, (n) => n);
}

function manifestMatches(
  manifests: readonly DependencyManifestRecord[] | undefined,
  query: string | RegExp,
  normalize: (n: string) => string,
): boolean {
  if (!manifests || manifests.length === 0) return false;
  const isRegex = query instanceof RegExp;
  const needle = isRegex ? null : normalize(query as string);
  for (const m of manifests) {
    for (const dep of Object.keys(m.dependencies)) {
      const candidate = normalize(dep);
      if (isRegex) {
        if ((query as RegExp).test(dep) || (query as RegExp).test(candidate)) return true;
      } else {
        if (candidate === needle) return true;
      }
    }
  }
  return false;
}

/** PEP 503 name normalization: lowercase, `_` and `.` → `-`. */
function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[_.]/g, '-');
}
