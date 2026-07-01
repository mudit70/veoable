import { JadeAPI } from './api.js';

// Nested chain `this.api.jade.sendRequest(...)`.
export class Page {
  private api = new JadeAPI();

  async loadVersions() {
    return this.api.jade.sendRequest('GetVersions', {});
  }
}

// Plain identifier shape — `client.sendRequest(...)`.
import { PostAPIClient } from './clients.js';

export async function listUsers() {
  const client = new PostAPIClient({ url: '/api/admin' });
  return client.sendRequest('ListUsers', {});
}
