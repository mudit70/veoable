import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createFetchVisitor } from './visitor.js';

/**
 * Fetch client-side API caller framework plugin (#78 under #2).
 *
 * Detects calls to the platform-built-in `fetch(...)` API and emits
 * canonical `ClientSideAPICaller` nodes. Stateless and
 * framework-agnostic: the same plugin instance can analyze any
 * number of projects without reset, and it applies to any TS/JS
 * project because `fetch` is a browser / Node 18+ built-in rather
 * than a dependency.
 */
export const FETCH_PLUGIN_ID = 'fetch' as const;

export class FetchPlugin implements FrameworkPlugin {
  readonly id = FETCH_PLUGIN_ID;
  readonly language = 'ts';

  /**
   * Returns true always. `fetch` is a platform built-in — there is
   * no dependency signal to key off, and any TS/JS project might
   * use it. A project that doesn't use `fetch` simply produces no
   * `ClientSideAPICaller` nodes from this plugin, which is harmless.
   *
   * This is intentionally different from `framework-axios` (which
   * will check for `axios` in deps) and every ORM plugin (which
   * checks for the ORM package). `fetch` is the odd one out.
   */
  appliesTo(_ctx: ProjectContext): boolean {
    return true;
  }

  readonly visitor: TsFrameworkVisitor = createFetchVisitor();
}
