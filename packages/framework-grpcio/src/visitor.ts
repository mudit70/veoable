import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@adorable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@adorable/lang-py';

/**
 * grpcio visitor.
 *
 *   class GreeterServicer:
 *       def SayHello(self, request, context): ...
 *
 *   class Greeter(helloworld_pb2_grpc.GreeterServicer):
 *       def SayHello(self, request, context): ...    # ← detected
 *       async def SayHelloStream(self, request, context): ...
 *
 * Detection rule:
 *   1. `class_definition` node
 *   2. Any superclass identifier (bare or scoped) ends with `Servicer`
 *   3. Service name = parent class identifier with `Servicer` stripped
 *      (e.g. `GreeterServicer` → `Greeter`).
 *   4. For each `function_definition` / `async function_definition`
 *      in the class body, emit one APIEndpoint:
 *        - httpMethod: 'GRPC'
 *        - routePattern: 'grpc:<Service>/<methodName>'
 *        - handlerFunctionId: id of `<ClassName>.<methodName>`
 *          (lang-py registers methods under that exact name).
 *        - framework: 'grpcio'
 *
 * Conservative v1:
 *   - Service-name extraction uses ONLY the parent class identifier.
 *     The actual gRPC service name (from `.proto` package + service)
 *     would require parsing `*_pb2.py` / `*_pb2_grpc.py`. Codebases
 *     whose Python class names track their proto service names
 *     (the overwhelming majority) get the right routePattern.
 *   - `__init__` and any other dunder methods are skipped — they
 *     aren't gRPC handlers.
 */
export const GRPCIO_PLUGIN_ID = 'grpcio' as const;

export function createGrpcioVisitor(): PyFrameworkVisitor {
  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'class_definition') return;

      const classNameNode = node.childForFieldName('name');
      const className = classNameNode?.text;
      if (!className) return;

      // A class can inherit from MULTIPLE `*Servicer` bases (rare,
      // but supported by grpcio). Emit one APIEndpoint per
      // (service, method) pair so the API surface is fully covered.
      const serviceNames = extractServiceNames(node);
      if (serviceNames.length === 0) return;

      const body = node.childForFieldName('body');
      if (!body) return;

      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (!child) continue;
        const methodNode = extractMethod(child);
        if (!methodNode) continue;

        const methodNameNode = methodNode.childForFieldName('name');
        const methodName = methodNameNode?.text;
        if (!methodName) continue;
        if (methodName.startsWith('__')) continue;

        for (const serviceName of serviceNames) {
          emitEndpoint(ctx, methodNode, serviceName, className, methodName);
        }
      }
    },
  };
}

function emitEndpoint(
  ctx: PyVisitContext,
  methodNode: SyntaxNode,
  serviceName: string,
  className: string,
  methodName: string,
): void {
  const methodLine = methodNode.startPosition.row + 1;
  const routePattern = `grpc:${serviceName}/${methodName}`;

  const handlerFunctionId = idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name: `${className}.${methodName}`,
    sourceLine: methodLine,
  });

  const snippet = methodNode.text;
  const evidence = {
    filePath: ctx.sourceFile.filePath,
    lineStart: methodLine,
    lineEnd: methodNode.endPosition.row + 1,
    snippet: snippet.length <= 500 ? snippet : snippet.slice(0, 499) + '…',
    confidence: 'exact' as const,
  };

  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'GRPC',
      routePattern,
      filePath: evidence.filePath,
      lineStart: evidence.lineStart,
    }),
    httpMethod: 'GRPC',
    routePattern,
    handlerFunctionId,
    framework: 'grpcio',
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(endpoint);
}

/**
 * Find ALL superclasses whose final identifier segment ends with
 * `Servicer`, returning service names (suffix stripped). Returns
 * empty array when no Servicer base is present.
 *
 * Handles both:
 *   class Greeter(GreeterServicer): ...                                 → ['Greeter']
 *   class Greeter(helloworld_pb2_grpc.GreeterServicer): ...             → ['Greeter']
 *   class MultiBase(GreeterServicer, EchoServicer): ...                 → ['Greeter', 'Echo']
 *   class Mixin(abc.ABC, helloworld_pb2_grpc.GreeterServicer): ...      → ['Greeter']
 */
function extractServiceNames(classNode: SyntaxNode): string[] {
  const superclasses = classNode.childForFieldName('superclasses');
  if (!superclasses) return [];

  const services: string[] = [];
  for (let i = 0; i < superclasses.childCount; i++) {
    const c = superclasses.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;

    const text = lastDottedSegment(c.text);
    if (text.endsWith('Servicer') && text.length > 'Servicer'.length) {
      services.push(text.slice(0, -'Servicer'.length));
    }
  }
  return services;
}

/**
 * `foo.bar.Baz` → `Baz`; `Baz` → `Baz`. Used to peel `pb2_grpc.`
 * prefixes off the generated servicer reference.
 */
function lastDottedSegment(text: string): string {
  const idx = text.lastIndexOf('.');
  return idx >= 0 ? text.slice(idx + 1) : text;
}

/**
 * Return the actual `function_definition` node if `node` is a method
 * (possibly wrapped in `decorated_definition` for decorators).
 * Returns null for anything else (assignment, comment, ...).
 */
function extractMethod(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'function_definition') return node;
  if (node.type === 'decorated_definition') {
    const def = node.childForFieldName('definition');
    if (def && def.type === 'function_definition') return def;
  }
  return null;
}
