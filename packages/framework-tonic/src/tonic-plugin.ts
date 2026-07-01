import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasCargoCrate } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';
import { createTonicVisitor } from './visitor.js';

/**
 * tonic framework plugin (#439 third slice — gRPC).
 *
 * Tonic is the de-facto Rust gRPC framework. Service implementations
 * are written as a struct + a `#[tonic::async_trait] impl <Trait>
 * for <Struct>` block whose async methods correspond to the gRPC
 * service's RPC methods.
 *
 *   #[tonic::async_trait]
 *   impl Greeter for MyGreeter {
 *       async fn say_hello(&self, request: Request<HelloRequest>)
 *           -> Result<Response<HelloReply>, Status> { ... }
 *
 *       async fn say_goodbye(&self, request: Request<GoodbyeRequest>)
 *           -> Result<Response<GoodbyeReply>, Status> { ... }
 *   }
 *
 * Each method becomes an APIEndpoint with httpMethod='GRPC' and
 * routePattern='grpc:<Trait>/<method>'. Mirrors the BullMQ +
 * mcp-server pattern — reuse APIEndpoint with a marker httpMethod so
 * every existing query tool (list_server_endpoints, impact_analysis,
 * walk_flows, ...) surfaces these for free.
 *
 * Detection is conservative for v1: only the fully-scoped
 * `#[tonic::async_trait]` form is accepted. The bare `#[async_trait]`
 * form (after `use tonic::async_trait;`) is a follow-up that rides on
 * issue #444's per-crate import-scanner extraction.
 */
export const TONIC_PLUGIN_ID = 'tonic' as const;

export class TonicPlugin implements FrameworkPlugin {
  readonly id = TONIC_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'tonic');
  }

  readonly visitor: RustFrameworkVisitor = createTonicVisitor();
}
