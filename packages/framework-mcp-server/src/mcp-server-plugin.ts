import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createMcpServerVisitor } from './visitor.js';

/**
 * #272 first slice — detect MCP server tool registrations and emit
 * them as `APIEndpoint` nodes with `httpMethod: 'TOOL'`. Mirrors the
 * pattern framework-bullmq established: stay inside the existing
 * schema, reuse the flow-stitcher + every MCP query tool for free, and
 * defer a richer `Trigger`-node schema upgrade until the abstraction
 * actually feels wrong.
 *
 * Detection signal: `@modelcontextprotocol/sdk` in dependencies or
 * devDependencies. Activation is conservative — projects that use
 * MCP but don't list the SDK in package.json (e.g. monorepo subtrees
 * with hoisted deps) need the parent package.json to advertise it.
 */
export const MCP_SERVER_PLUGIN_ID = 'mcp-server' as const;

const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';

export class MCPServerPlugin implements FrameworkPlugin {
  readonly id = MCP_SERVER_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return MCP_SDK_PACKAGE in deps;
  }

  readonly visitor: TsFrameworkVisitor = createMcpServerVisitor();
}
