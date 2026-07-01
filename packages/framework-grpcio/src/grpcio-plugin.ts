import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createGrpcioVisitor } from './visitor.js';

/**
 * grpcio framework plugin — Python gRPC servicer detection.
 *
 * Mirrors framework-tonic's role on the Rust side: every async/sync
 * method on a class that inherits from a generated `*Servicer` base
 * is an RPC handler, so we emit one APIEndpoint per method with
 * `httpMethod: 'GRPC'`, `routePattern: 'grpc:<Service>/<method>'`.
 *
 * Service name = the parent class identifier with the trailing
 * `Servicer` stripped (`GreeterServicer` → `Greeter`). This is the
 * convention `grpcio-tools` (the Python protoc plugin) uses when
 * generating the base classes from `.proto` files.
 *
 * Activation: any of `grpcio`, `grpcio-tools`, or `grpc-stubs` in a
 * Python manifest (requirements.txt / pyproject.toml / Pipfile).
 */
export const GRPCIO_PLUGIN_ID = 'grpcio' as const;

export class GrpcioPlugin implements FrameworkPlugin {
  readonly id = GRPCIO_PLUGIN_ID;
  readonly language = 'py';

  appliesTo(ctx: ProjectContext): boolean {
    return (
      hasPythonPackage(ctx, 'grpcio')
      || hasPythonPackage(ctx, 'grpcio-tools')
      || hasPythonPackage(ctx, 'grpc-stubs')
    );
  }

  readonly visitor: PyFrameworkVisitor = createGrpcioVisitor();
}
