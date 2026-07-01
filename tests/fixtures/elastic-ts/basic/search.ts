import { Client } from '@elastic/elasticsearch';

const client = new Client({ node: 'http://localhost:9200' });

export async function indexUser(id: string, name: string) {
  return client.index({ index: 'users', id, document: { name } });
}

export async function searchUsers(query: string) {
  return client.search({ index: 'users', query: { match: { name: query } } });
}

export async function getUser(id: string) {
  return client.get({ index: 'users', id });
}

export async function deleteUser(id: string) {
  return client.delete({ index: 'users', id });
}

export async function updateUser(id: string, name: string) {
  return client.update({ index: 'users', id, doc: { name } });
}

export async function countOrders() {
  return client.count({ index: 'orders' });
}

export async function existsAudit(id: string) {
  return client.exists({ index: 'audit-log', id });
}

export async function dynamicIndex(index: string) {
  // Dynamic — no literal index → no emit.
  return client.search({ index, query: { match_all: {} } });
}
