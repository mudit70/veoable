// PostAPIClient stub mimicking the Sixclear PostAPIClient signature.
export class PostAPIClient<T = unknown> {
  constructor(_cfg: { url: string }) {
    void this; void _cfg;
  }
  async sendRequest<K extends keyof T & string>(
    _method: K,
    _payload: unknown,
  ): Promise<{ data: unknown }> {
    return { data: null };
  }
}
