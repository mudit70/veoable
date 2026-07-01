import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createAiohttpVisitor } from './visitor.js';

/**
 * aiohttp framework plugin — Python's async HTTP framework.
 *
 * Covers BOTH directions in one visitor:
 *   - Server-side route registration → APIEndpoint
 *   - Outbound HTTP via ClientSession → ClientSideAPICaller
 *
 * Same pattern framework-gohttp uses on the Go side (net/http server
 * + net/http client in one plugin).
 *
 * Activation: any `aiohttp` entry in a Python manifest.
 */
export const AIOHTTP_PLUGIN_ID = 'aiohttp' as const;

export class AiohttpPlugin implements FrameworkPlugin {
  readonly id = AIOHTTP_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'aiohttp');
  }

  readonly visitor: PyFrameworkVisitor = createAiohttpVisitor();
}
