import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasDependency } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createExpressVisitor } from './visitor.js';

/**
 * Express framework plugin (#15).
 *
 * Detects server-side API endpoints declared via the Express routing
 * API (`app.get('/path', handler)`, `router.post(...)`, etc.) and
 * emits canonical `APIEndpoint` nodes.
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset. Mirrors the React plugin's shape: no
 * `onProjectLoaded` hook, no per-project state, visitor constructed
 * once and returned as the same reference on every access.
 */
export const EXPRESS_PLUGIN_ID = 'express' as const;

export class ExpressPlugin implements FrameworkPlugin {
  readonly id = EXPRESS_PLUGIN_ID;
  readonly language = 'ts';

  /**
   * Returns true when the current project looks like an Express
   * project: `express` is listed in dependencies / devDependencies /
   * peerDependencies of any manifest in the project tree (root or any
   * subpackage; #184). The filesystem fallback (grepping files for
   * `require('express')`) is deliberately omitted — any real Express
   * project has the dependency listed.
   */
  appliesTo(ctx: ProjectContext): boolean {
    return hasDependency(ctx, 'express');
  }

  readonly visitor: TsFrameworkVisitor = createExpressVisitor();
}
