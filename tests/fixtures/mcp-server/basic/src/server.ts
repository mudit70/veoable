// Minimal MCP server stub for the framework-mcp-server visitor's
// fixture. We don't actually import @modelcontextprotocol/sdk
// because the visitor matches on the call shape, not on a typed
// receiver — keeping the fixture dep-free makes the test fast.
declare class McpServer {
  tool(
    name: string,
    description: string,
    params: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void;
}

const server = new McpServer();

server.tool(
  'list_repositories',
  'Return the project name and all repositories.',
  {},
  async () => ({ repositories: [] }),
);

server.tool(
  'get_node',
  'Get a single node by id and type.',
  { nodeType: 'string', id: 'string' },
  async () => ({ node: null }),
);

server.tool(
  'echo',
  'Echo the input back, useful for ping checks.',
  { message: 'string' },
  async ({ message }) => ({ message }),
);

// Negative case: not enough args — should NOT register as a tool.
server.tool('half-baked', 'only two args');

// Negative case: dynamic name — should be skipped.
const dynamicName = 'computed_at_runtime';
server.tool(dynamicName, 'dynamic tool name', {}, async () => null);
