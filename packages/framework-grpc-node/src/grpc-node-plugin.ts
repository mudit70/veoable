import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createGrpcNodeVisitor } from './visitor.js';

/**
 * gRPC server (TypeScript / Node) framework plugin.
 *
 * Mirrors framework-grpcio (Python), framework-grpcgo (Go), and
 * framework-tonic (Rust) — emits one `APIEndpoint` per RPC method
 * with `httpMethod='GRPC'` and `routePattern='grpc:<service>/<method>'`.
 *
 * Detected call shape:
 *
 *   import { Server } from '@grpc/grpc-js';
 *   const server = new Server();
 *   server.addService(MyServiceService, {
 *     SayHello: (call, cb) => { ... },
 *     SayGoodbye: handlerFn,
 *   });
 *
 * For each method in the second argument's object literal, an
 * APIEndpoint is emitted. The service name is derived from the
 * first argument's identifier — typically the protobuf-generated
 * `<ServiceName>Service` constant.
 *
 * Activation: `@grpc/grpc-js` in package.json dependencies or
 * devDependencies. Per-file gate: any import from `@grpc/grpc-js`.
 */
export const GRPC_NODE_PLUGIN_ID = 'grpc-node' as const;

export class GrpcNodePlugin implements FrameworkPlugin {
  readonly id = GRPC_NODE_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return '@grpc/grpc-js' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createGrpcNodeVisitor();
}
