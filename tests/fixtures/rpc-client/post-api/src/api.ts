import { PostAPIClient } from './clients.js';

interface JadeAPISignatures {
  GenerateBundle: { spec: unknown };
  GetBundle: { id: string };
  GetVersions: Record<string, never>;
}

// Class-field initialiser shape — `this.jade.sendRequest(...)`.
export class JadeAPI {
  public jade: PostAPIClient<JadeAPISignatures>;
  constructor() {
    this.jade = new PostAPIClient({ url: '/api/jade' });
  }

  async generateBundle(spec: unknown) {
    return this.jade.sendRequest('GenerateBundle', { spec });
  }
  async getBundle(id: string) {
    return this.jade.sendRequest('GetBundle', { id });
  }
  async getVersions() {
    return this.jade.sendRequest('GetVersions', {});
  }
}
