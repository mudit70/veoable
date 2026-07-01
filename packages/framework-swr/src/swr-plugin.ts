import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createSwrVisitor } from './visitor.js';

/**
 * SWR framework plugin (#550).
 *
 * SWR hooks (`useSWR(key, fetcher)`, `useSWRMutation`, ...) register a
 * fetcher to be called by the SWR runtime on cache-miss or revalidate.
 * Without this plugin the flow walker terminates at the hook call site
 * because the lang-ts call graph has no edge from `useSWR` to the
 * resolved fetcher — it's a value being registered, not directly
 * invoked.
 *
 * Closes that gap by emitting:
 *   - a `ClientSideProcess` (kind: 'lifecycle_hook', framework: 'swr')
 *     per hook call, attributed to the enclosing component / custom hook
 *   - a `TRIGGERS` edge from the process to the resolved fetcher
 */
export const SWR_PLUGIN_ID = 'swr' as const;

const SUPPORTED_PACKAGES = [
  'swr',
];

export class SwrPlugin implements FrameworkPlugin {
  readonly id = SWR_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return SUPPORTED_PACKAGES.some((name) => name in deps);
  }

  readonly visitor: TsFrameworkVisitor = createSwrVisitor();
}
