import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createHttpxVisitor } from './visitor.js';

/**
 * Python HTTP-client framework plugin (outbound calls).
 *
 * Covers `httpx` AND `requests` — their APIs are near-identical for
 * the surface we care about (top-level convenience + client/session
 * method chain), so one visitor handles both. Per-file detection
 * inside the visitor picks the framework name to stamp on each
 * caller (`httpx` vs `requests`).
 *
 * Emits one `ClientSideAPICaller` per recognized outbound call site
 * with a `MAKES_REQUEST` edge back to the enclosing function —
 * matches the framework-axios / framework-reqwest emit shape.
 */
export const HTTPX_PLUGIN_ID = 'httpx' as const;

export class HttpxPlugin implements FrameworkPlugin {
  readonly id = HTTPX_PLUGIN_ID;
  readonly language = 'py';

  /**
   * Activates when either `httpx` or `requests` is declared in any
   * Python manifest in the project.
   */
  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'httpx') || hasPythonPackage(ctx, 'requests');
  }

  readonly visitor: PyFrameworkVisitor = createHttpxVisitor();
}
