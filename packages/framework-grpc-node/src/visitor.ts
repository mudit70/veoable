import { Node, type Expression } from 'ts-morph';
import {
  idFor,
  type APIEndpoint,
} from '@veoable/schema';
import {
  buildEvidence,
  resolveHandlerToFunctionId,
  type TsFrameworkVisitor,
} from '@veoable/lang-ts';

/**
 * @grpc/grpc-js server visitor.
 *
 * Detects `<server>.addService(<ServiceDef>, { method1: handler1, ... })`
 * and emits one `APIEndpoint` per method in the handler object literal.
 *
 *   routePattern = `grpc:<service-name>/<method-name>`
 *   httpMethod   = 'GRPC'
 *   framework    = 'grpc-node'
 *
 * Per-file gate: file must import from `@grpc/grpc-js`. Without this
 * gate, any third-party `addService` call could match.
 */
export function createGrpcNodeVisitor(): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();

  const fileImports = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === '@grpc/grpc-js' || spec.startsWith('@grpc/grpc-js/');
    });
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!fileImports(node, ctx.sourceFile.filePath)) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      if (callee.getNameNode().getText() !== 'addService') return;

      const args = node.getArguments();
      if (args.length < 2) return;

      const serviceName = extractServiceName(args[0] as Expression);
      const handlersObj = args[1];
      if (!Node.isObjectLiteralExpression(handlersObj)) return;

      const properties = handlersObj.getProperties();
      for (const prop of properties) {
        const methodName = readPropertyMethodName(prop);
        if (!methodName) continue;
        const handlerExpr = readPropertyHandlerExpression(prop);
        const routePattern = `grpc:${serviceName}/${methodName}`;
        const evidence = buildEvidence(node, ctx.sourceFile.filePath);
        const handlerFunctionId = handlerExpr
          ? resolveHandlerToFunctionId(handlerExpr, node, ctx, 'grpc-node')
          : null;

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
          framework: 'grpc-node',
          repository: ctx.sourceFile.repository,
          evidence,
        };
        ctx.emitNode(endpoint);
      }
    },
  };
}

function readPropertyMethodName(prop: Node): string | null {
  if (Node.isPropertyAssignment(prop)) {
    const nameNode = prop.getNameNode();
    // Skip computed-property names — `{ [SayHello]: handler }`
    // produces `getName() === "[SayHello]"` which would emit a junk
    // routePattern. Resolving the constant is out of scope here;
    // dropping silently is the right safe default.
    if (Node.isComputedPropertyName(nameNode)) return null;
    return prop.getName() ?? null;
  }
  if (Node.isShorthandPropertyAssignment(prop)) {
    return prop.getName();
  }
  if (Node.isMethodDeclaration(prop)) {
    const nameNode = prop.getNameNode();
    if (Node.isComputedPropertyName(nameNode)) return null;
    return nameNode ? nameNode.getText() : null;
  }
  return null;
}

function readPropertyHandlerExpression(prop: Node): Expression | null {
  if (Node.isPropertyAssignment(prop)) {
    return prop.getInitializer() ?? null;
  }
  if (Node.isShorthandPropertyAssignment(prop)) {
    return prop.getNameNode();
  }
  return null;
}

/**
 * Extract a service name from the first arg. Typically a generated
 * constant like `MyServiceService` or `Greeter.service`. We use the
 * trailing identifier with the `Service` suffix stripped to get
 * `MyService`. For dotted forms like `pkg.Greeter.service`, take
 * the second-to-last segment.
 */
function extractServiceName(expr: Expression): string {
  const text = expr.getText();
  // `Greeter.service` / `pkg.Greeter.service` form.
  const dotMatch = /^(?:[\w$]+\.)*([\w$]+)\.service$/.exec(text);
  if (dotMatch) return dotMatch[1];
  // `MyServiceService` form — strip trailing `Service` if present.
  const idMatch = /^([\w$]+)$/.exec(text);
  if (idMatch) {
    const id = idMatch[1];
    if (id.endsWith('Service')) return id.slice(0, -'Service'.length);
    return id;
  }
  return text.length > 0 ? text : '<unknown>';
}

