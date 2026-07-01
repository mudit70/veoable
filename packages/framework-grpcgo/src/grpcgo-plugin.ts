import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { createGrpcgoVisitor } from './visitor.js';

/**
 * Go gRPC framework plugin — server-side detection.
 *
 * Mirrors framework-tonic (Rust) / framework-grpcio (Python). One
 * APIEndpoint per method on a struct that embeds a generated
 * `Unimplemented<Service>Server` struct (the canonical pattern
 * protoc-gen-go-grpc produces).
 *
 * Service name = the embedded struct's identifier with
 * `Unimplemented` peeled from the front and `Server` peeled from
 * the back (`UnimplementedGreeterServer` → `Greeter`).
 *
 * Activation: any of `google.golang.org/grpc`,
 * `google.golang.org/protobuf` in a go.mod under the project.
 */
export const GRPCGO_PLUGIN_ID = 'grpcgo' as const;

export class GrpcgoPlugin implements FrameworkPlugin {
  readonly id = GRPCGO_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    return (
      hasGoModule(ctx, 'google.golang.org/grpc')
      || hasGoModule(ctx, 'google.golang.org/protobuf')
    );
  }

  readonly visitor: GoFrameworkVisitor = createGrpcgoVisitor();
}
