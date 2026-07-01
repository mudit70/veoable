// A class with sendRequest that is NOT an RPC client per the
// allowlist. The visitor must NOT emit a ClientSideAPICaller here.

class HttpHelper {
  constructor(_cfg: { url: string }) { void this; void _cfg; }
  async sendRequest(_method: string, _payload: unknown): Promise<unknown> {
    return null;
  }
}

const helper = new HttpHelper({ url: '/api/not-rpc' });

export async function someAction() {
  // Same sendRequest('Method', payload) call shape, but the
  // constructor name (HttpHelper) is NOT in RPC_CLIENT_CTORS.
  return helper.sendRequest('DoSomething', {});
}
