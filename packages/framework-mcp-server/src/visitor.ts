import { Node, type Expression } from 'ts-morph';
import { idFor, type APIEndpoint } from '@adorable/schema';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  readStringLiteral,
  resolveHandlerToFunctionId,
} from '@adorable/lang-ts';

/**
 * MCP server tool registration visitor (#272 first slice).
 *
 * Detects:
 *
 *     server.tool(
 *       'tool_name',          // string literal
 *       'description string', // string literal
 *       { ...zodSchema },     // params object
 *       async (args) => { ... } // handler
 *     );
 *
 * and emits each call as an `APIEndpoint` with `httpMethod: 'TOOL'`
 * and `routePattern: 'mcp:<tool_name>'`. This mirrors the BullMQ
 * pattern: every existing flow-walking + impact-analysis MCP tool
 * surfaces these without modification. The tool name is the binding
 * key, parallel to a queue name or an HTTP route.
 *
 * Detection is conservative:
 *   - Must be a call expression on a `<expr>.tool` property access.
 *   - First two arguments must be string literals (name, description).
 *   - Must have at least 3 arguments (name, description, schema). A
 *     fourth handler argument is required for handler resolution but
 *     the node is still emitted without it when missing — we just lose
 *     the `handlerFunctionId` field.
 *
 * False-positive surface is bounded by the `appliesTo` gate in
 * MCPServerPlugin (the SDK must be in dependencies). Non-MCP code that
 * happens to call `.tool('a', 'b', ...)` won't activate the plugin.
 */
export function createMcpServerVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      if (callee.getNameNode().getText() !== 'tool') return;

      const args = node.getArguments();
      if (args.length < 3) return; // name + description + schema minimum
      const nameArg = args[0];
      const descArg = args[1];

      const toolName = readStringLiteral(nameArg);
      if (!toolName) return;
      // Description can be a string literal or a multi-line concat —
      // we accept either by stringifying the first literal, but require
      // the second arg to BE a literal to confirm we're looking at the
      // SDK shape.
      const description = readStringLiteral(descArg);
      if (description === null) return;

      // Handler is the 4th argument (3rd is the params object). It's
      // optional in some SDK shapes; emit the endpoint either way.
      let handlerFunctionId: string | null = null;
      if (args.length >= 4) {
        const handlerExpr = args[3] as Expression;
        handlerFunctionId = resolveHandlerToFunctionId(
          handlerExpr,
          node,
          ctx,
          'mcp-server',
        );
      }

      const routePattern = `mcp:${toolName}`;
      const evidence = buildEvidence(node, ctx.sourceFile.filePath);
      const endpoint: APIEndpoint = {
        nodeType: 'APIEndpoint',
        id: idFor.apiEndpoint({
          repository: ctx.sourceFile.repository,
          httpMethod: 'TOOL',
          routePattern,
          filePath: evidence.filePath,
          lineStart: evidence.lineStart,
        }),
        httpMethod: 'TOOL',
        routePattern,
        handlerFunctionId,
        framework: 'mcp-server',
        repository: ctx.sourceFile.repository,
        evidence,
      };
      ctx.emitNode(endpoint);
    },
  };
}

