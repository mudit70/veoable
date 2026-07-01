import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createTrpcClientVisitor } from './visitor.js';

/**
 * tRPC client framework plugin (#551).
 *
 * The existing `framework-trpc` plugin covers SERVER-side procedure
 * declarations (`router({ getUser: publicProcedure.query(...) })`),
 * emitting `APIEndpoint`s with `routePattern: '/trpc/<path>'`. The
 * client-side proxy call pattern
 *
 *     trpc.users.create.useMutation()
 *     trpc.users.list.useQuery({ ... })
 *     await client.users.get.query(input)
 *     await client.users.create.mutate(input)
 *
 * was NOT covered: the lang-ts call graph saw a chain of property
 * accesses ending in `useMutation()` / `query()` / `mutate()` and
 * emitted nothing. The flow walker terminated at the call site
 * without crossing to the server endpoint.
 *
 * This plugin closes that gap. Per recognized client call it emits a
 * `ClientSideAPICaller` with `urlLiteral: '/trpc/<procedure.path>'`
 * which the flow-stitcher matches against the existing tRPC server
 * endpoint's `routePattern`.
 */
export const TRPC_CLIENT_PLUGIN_ID = 'trpc-client' as const;

// Client-only deps. `@trpc/server` is intentionally excluded — a
// server-only project would otherwise activate this client plugin
// unnecessarily. If a project uses both client and server, one of
// the client-side deps is always present.
const SUPPORTED_PACKAGES = [
  '@trpc/react-query',
  '@trpc/next',
  '@trpc/client',
];

export class TrpcClientPlugin implements FrameworkPlugin {
  readonly id = TRPC_CLIENT_PLUGIN_ID;
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

  readonly visitor: TsFrameworkVisitor = createTrpcClientVisitor();
}
