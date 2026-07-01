import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type APIEndpoint, type SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { MCPServerPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/mcp-server/basic');

async function extract(file: string): Promise<NodeBatch> {
  const mcp = new MCPServerPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(mcp.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('MCP server.tool() → APIEndpoint (#272 first slice)', () => {
  it('emits one APIEndpoint per `<server>.tool(name, desc, schema, handler)` call', async () => {
    const batch = await extract('src/server.ts');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => e.routePattern).sort();
    expect(patterns).toEqual([
      'mcp:echo',
      'mcp:get_node',
      'mcp:list_repositories',
    ]);
  });

  it('marks each as httpMethod=TOOL and framework=mcp-server', async () => {
    const batch = await extract('src/server.ts');
    for (const ep of endpoints(batch)) {
      expect(ep.httpMethod).toBe('TOOL');
      expect(ep.framework).toBe('mcp-server');
    }
  });

  it('skips calls with too few arguments (no description literal)', async () => {
    // The fixture has `server.tool('half-baked', 'only two args')`
    // — that's 2 args, less than the required 3 (name + desc + schema).
    // Should NOT appear in the endpoint list.
    const batch = await extract('src/server.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).not.toContain('mcp:half-baked');
  });

  it('skips calls with a non-literal tool name (dynamic registration)', async () => {
    // The fixture has `server.tool(dynamicName, ...)` — should be
    // dropped because the name isn't a string literal.
    const batch = await extract('src/server.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).not.toContain('mcp:computed_at_runtime');
  });

  it('attaches SourceEvidence (filePath + lineStart) so source-quoting MCP tools work', async () => {
    const batch = await extract('src/server.ts');
    const list = endpoints(batch).find((e) => e.routePattern === 'mcp:list_repositories');
    expect(list).toBeTruthy();
    expect(list!.evidence?.filePath).toContain('server.ts');
    expect(list!.evidence?.lineStart).toBeGreaterThan(0);
  });
});
