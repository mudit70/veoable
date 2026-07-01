import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@veoable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@veoable/lang-go';

/**
 * grpc-go visitor.
 *
 * Canonical protoc-gen-go-grpc shape:
 *
 *   type greeterServer struct {
 *       pb.UnimplementedGreeterServer
 *   }
 *
 *   func (s *greeterServer) SayHello(ctx context.Context, req *pb.HelloRequest)
 *       (*pb.HelloReply, error) { ... }
 *
 *   func (s *greeterServer) SayHelloStream(req *pb.HelloRequest,
 *       stream pb.Greeter_SayHelloStreamServer) error { ... }
 *
 * Detection rule:
 *   1. Find every struct that embeds `Unimplemented<Name>Server`
 *      (either bare like `UnimplementedGreeterServer` or scoped
 *      like `pb.UnimplementedGreeterServer`). Record:
 *        struct-type-name → service-name
 *      e.g. `greeterServer` → `Greeter`.
 *
 *   2. For every method on such a struct, emit:
 *        - httpMethod: 'GRPC'
 *        - routePattern: 'grpc:<Service>/<MethodName>'
 *        - handlerFunctionId: id of `<RecvType>.<MethodName>`
 *          (lang-go registers methods under exactly that name).
 *        - framework: 'grpcgo'
 *
 * Method visitation can fire BEFORE the struct's type_declaration in
 * source order, so the receiver→service map is built lazily by
 * scanning the module's top-level type_declarations on first
 * dispatch per file. Same per-file-cached approach fastapi uses for
 * router prefixes.
 */

export function createGrpcgoVisitor(): GoFrameworkVisitor {
  // Per-file map: receiverTypeName → list of service names (a single
  // struct can embed multiple `Unimplemented*Server` types — rare but
  // supported).
  const servicersByFile = new Map<string, Map<string, string[]>>();
  const getServicers = (filePath: string, root: SyntaxNode): Map<string, string[]> => {
    let m = servicersByFile.get(filePath);
    if (!m) {
      m = scanModuleForServicers(root);
      servicersByFile.set(filePath, m);
    }
    return m;
  };

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'method_declaration') return;

      const servicers = getServicers(ctx.sourceFile.filePath, node.tree.rootNode);
      if (servicers.size === 0) return;

      const receiverType = extractReceiverType(node);
      if (!receiverType) return;
      const serviceNames = servicers.get(receiverType);
      if (!serviceNames || serviceNames.length === 0) return;

      const methodNameNode = node.childForFieldName('name');
      const methodName = methodNameNode?.text;
      if (!methodName) return;

      // A struct can embed MULTIPLE `Unimplemented*Server` types
      // (rare, but supported). Emit one APIEndpoint per service.
      for (const serviceName of serviceNames) {
        emitEndpoint(ctx, node, serviceName, receiverType, methodName);
      }
    },
  };
}

function emitEndpoint(
  ctx: GoVisitContext,
  methodNode: SyntaxNode,
  serviceName: string,
  receiverType: string,
  methodName: string,
): void {
  const methodLine = methodNode.startPosition.row + 1;
  const routePattern = `grpc:${serviceName}/${methodName}`;

  const handlerFunctionId = idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name: `${receiverType}.${methodName}`,
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
    framework: 'grpcgo',
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(endpoint);
}

/**
 * Walk the module's top-level type_declarations and find every
 * struct that embeds `Unimplemented<Name>Server`. Returns a map
 * from the struct's name to the service name.
 */
function scanModuleForServicers(rootNode: SyntaxNode): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (!child) continue;
    if (child.type !== 'type_declaration') continue;

    // `type_declaration` wraps one or more `type_spec` children.
    for (let j = 0; j < child.childCount; j++) {
      const spec = child.child(j);
      if (!spec || spec.type !== 'type_spec') continue;

      const nameNode = spec.childForFieldName('name');
      const typeNode = spec.childForFieldName('type');
      const structName = nameNode?.text;
      if (!structName || !typeNode || typeNode.type !== 'struct_type') continue;

      const serviceNames = findEmbeddedServicerNames(typeNode);
      if (serviceNames.length > 0) out.set(structName, serviceNames);
    }
  }
  return out;
}

/**
 * Scan a `struct_type` node's field list and return service names
 * for EVERY embedded type matching `Unimplemented<Name>Server`.
 *
 * Accepts both bare (`UnimplementedGreeterServer`) and scoped
 * (`pb.UnimplementedGreeterServer`) embedded types. Order preserved.
 */
function findEmbeddedServicerNames(structType: SyntaxNode): string[] {
  const fieldList = structType.childForFieldName('field_declaration_list')
    ?? structType.children.find((c) => c.type === 'field_declaration_list');
  if (!fieldList) return [];

  const services: string[] = [];
  for (let i = 0; i < fieldList.childCount; i++) {
    const field = fieldList.child(i);
    if (!field || field.type !== 'field_declaration') continue;

    // Embedded field: has a `type` child but no `name` field. The
    // type identifies the field implicitly.
    const nameField = field.childForFieldName('name');
    const typeField = field.childForFieldName('type');
    if (nameField || !typeField) continue;

    const text = lastDottedSegment(typeField.text);
    const service = stripUnimplementedServer(text);
    if (service) services.push(service);
  }
  return services;
}

/**
 * `UnimplementedGreeterServer` → `Greeter`. Returns null if the
 * text doesn't match the prefix+suffix shape (with a non-empty
 * middle).
 */
function stripUnimplementedServer(text: string): string | null {
  const PREFIX = 'Unimplemented';
  const SUFFIX = 'Server';
  if (!text.startsWith(PREFIX) || !text.endsWith(SUFFIX)) return null;
  const middle = text.slice(PREFIX.length, text.length - SUFFIX.length);
  return middle.length > 0 ? middle : null;
}

/**
 * Extract the bare receiver type name from a `method_declaration`.
 *
 *   func (s greeterServer) SayHello(...)        → 'greeterServer'
 *   func (s *greeterServer) SayHello(...)       → 'greeterServer'
 *   func (greeterServer) SayHello(...)          → 'greeterServer'
 *   func (s *pb.greeterServer) ...              → 'greeterServer'  (qualified)
 */
function extractReceiverType(methodNode: SyntaxNode): string | null {
  const receiver = methodNode.childForFieldName('receiver');
  if (!receiver) return null;

  // receiver is a `parameter_list` containing one `parameter_declaration`
  // whose `type` field is either a type_identifier, pointer_type, or
  // qualified_type.
  for (let i = 0; i < receiver.childCount; i++) {
    const pd = receiver.child(i);
    if (!pd || pd.type !== 'parameter_declaration') continue;
    const type = pd.childForFieldName('type');
    if (!type) continue;
    return peelToBareType(type);
  }
  return null;
}

function peelToBareType(node: SyntaxNode): string | null {
  // pointer_type — unwrap one level
  if (node.type === 'pointer_type') {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && c.type !== '*') return peelToBareType(c);
    }
    return null;
  }
  // qualified_type — the right side is the bare name
  if (node.type === 'qualified_type') {
    const name = node.childForFieldName('name');
    if (name) return name.text;
    // Fall back to the last identifier child.
    let last: SyntaxNode | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && c.type === 'type_identifier') last = c;
    }
    return last?.text ?? null;
  }
  if (node.type === 'type_identifier') return node.text;
  return null;
}

function lastDottedSegment(text: string): string {
  const idx = text.lastIndexOf('.');
  return idx >= 0 ? text.slice(idx + 1) : text;
}
