/**
 * Application-pair scoping (#255).
 *
 * In a monorepo with multiple applications (e.g., musiccardapp's
 * React Native client + admin web app, each with its own backend),
 * the stitcher would otherwise greedily match any client URL to any
 * endpoint with the same path — producing cross-application stitches
 * (RN client → admin backend) that aren't real flows.
 *
 * The `applications` field in the project config declares which
 * repositories belong to the same application. The stitcher uses this
 * to restrict caller→endpoint matches to repos that share at least
 * one application.
 *
 * Default (no `applications` configured) is permissive — every repo
 * can stitch to every other repo, preserving v1 behavior.
 *
 * Adoption is incremental: a repo not mentioned in any application
 * is treated as unscoped and continues to stitch to anything. Only
 * SCOPED callers (repos listed in some application) get restricted
 * to their application's endpoints.
 */

export interface Application {
  /** Friendly name (e.g., "rn-client", "admin", "ops"). Used in diagnostics. */
  name: string;
  /** List of repository names that compose this application. */
  repos: ReadonlyArray<string>;
}

export type ApplicationScope = (callerRepo: string, endpointRepo: string) => boolean;

/**
 * Build a scope function from an `applications` declaration. Returns
 * a function `(callerRepo, endpointRepo) => boolean` that is true
 * exactly when the pair is allowed to stitch.
 *
 * Semantics:
 *   - If `callerRepo` is not in any application: allow any endpoint
 *     (unscoped callers stitch as before).
 *   - If `endpointRepo` is not in any application: allow (permissive
 *     shared-services pattern — a util/shared repo not yet enumerated
 *     in any app is reachable from anywhere).
 *   - If BOTH are scoped: they must share at least one application.
 *
 * A repo can belong to multiple applications by appearing in more
 * than one `repos` list (e.g., a shared-utility backend reachable
 * from both apps).
 *
 * The asymmetry favors incremental adoption: declaring `applications`
 * for some repos in your monorepo never silently breaks flows to
 * un-declared repos. The block is targeted at the cross-app contamination
 * case (e.g., RN client → admin backend) where BOTH ends are explicitly
 * declared as parts of different applications.
 */
export function buildApplicationScope(applications: ReadonlyArray<Application>): ApplicationScope {
  if (applications.length === 0) {
    return () => true;
  }

  const repoToApps = new Map<string, Set<string>>();
  for (const app of applications) {
    for (const repo of app.repos) {
      let bucket = repoToApps.get(repo);
      if (!bucket) {
        bucket = new Set();
        repoToApps.set(repo, bucket);
      }
      bucket.add(app.name);
    }
  }

  return (callerRepo: string, endpointRepo: string) => {
    const callerApps = repoToApps.get(callerRepo);
    if (!callerApps || callerApps.size === 0) {
      // Unscoped caller — permissive.
      return true;
    }
    const endpointApps = repoToApps.get(endpointRepo);
    if (!endpointApps || endpointApps.size === 0) {
      // Scoped caller, unscoped endpoint — permissive (shared-service
      // pattern). The block targets cross-app contamination only.
      return true;
    }
    for (const app of callerApps) {
      if (endpointApps.has(app)) return true;
    }
    return false;
  };
}

/**
 * Permissive scope: always returns true. Used as the default when no
 * `applications` are configured, so call sites can apply the filter
 * unconditionally without branching.
 */
export const ALLOW_ANY_APPLICATION_PAIR: ApplicationScope = () => true;
