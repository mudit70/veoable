import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createRpcClientVisitor } from './visitor.js';

/**
 * Custom RPC client plugin (#408).
 *
 * Detects codebases that wrap `fetch` in a custom RPC client class —
 * specifically the `<receiver>.sendRequest('MethodName', payload)`
 * shape used by Sixclear's PostAPIClient and similar:
 *
 *   const jade = new PostAPIClient({ url: '/api/jade' });
 *   await jade.sendRequest('GenerateBundle', spec);
 *   // → POST /api/jade?r=GenerateBundle
 *
 * Recognised constructor names (allowlist; conservative on purpose
 * to avoid false positives on unrelated `Client` classes):
 *   - PostAPIClient
 *   - RpcClient / RPCClient
 *   - JsonRpcClient / JSONRPCClient
 *   - PostAPI / PostAPIBrowserClient
 *
 * Stateless and TS-language-only. `appliesTo` returns true always
 * (like framework-fetch) — a project that doesn't use any
 * recognised client simply produces no nodes.
 */
export const RPC_CLIENT_PLUGIN_ID = 'rpc-client' as const;

export class RpcClientPlugin implements FrameworkPlugin {
  readonly id = RPC_CLIENT_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(_ctx: ProjectContext): boolean {
    return true;
  }

  readonly visitor: TsFrameworkVisitor = createRpcClientVisitor();
}
