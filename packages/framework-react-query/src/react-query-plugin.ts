import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createReactQueryVisitor } from './visitor.js';

/**
 * `@tanstack/react-query` framework plugin (#549).
 *
 * Modern React apps use React Query hooks as the canonical way to
 * talk to a backend:
 *
 *     const { mutate } = useMutation({ mutationFn: createOrder });
 *     const { data } = useQuery({ queryKey: ['orders'], queryFn: listOrders });
 *
 * Without this plugin, the flow walker terminates at the hook call
 * site because the lang-ts call graph contains no edge from
 * `useMutation` to the resolved `mutationFn` value — the hook
 * *registers* the function for later invocation rather than calling
 * it directly. This plugin closes that gap by emitting:
 *
 *   - a `ClientSideProcess` (`kind: 'event_handler'`) per hook call
 *   - a `TRIGGERS` edge from the process to the resolved
 *     `mutationFn` / `queryFn` callee
 *
 * Activation: any of the supported package names in any
 * `dependencies` / `devDependencies` / `peerDependencies` field.
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const REACT_QUERY_PLUGIN_ID = 'react-query' as const;

const SUPPORTED_PACKAGES = [
  '@tanstack/react-query',
  '@tanstack/react-query-experimental',
  '@tanstack/solid-query',
  '@tanstack/vue-query',
  '@tanstack/svelte-query',
  'react-query', // v3 (pre-Tanstack split)
];

export class ReactQueryPlugin implements FrameworkPlugin {
  readonly id = REACT_QUERY_PLUGIN_ID;
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

  readonly visitor: TsFrameworkVisitor = createReactQueryVisitor();
}
