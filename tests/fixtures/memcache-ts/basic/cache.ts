import { Client } from 'memjs';

const client = Client.create();

export async function getUser(id: string) {
  return client.get(`user:${id}`);
}

export async function setUser(id: string, name: string) {
  return client.set(`user:${id}`, name, { expires: 60 });
}

export async function incrCounter() {
  return client.increment('counter:requests', 1);
}

export async function decrCounter() {
  return client.decrement('counter:errors', 1);
}

export async function deleteSession() {
  return client.delete('session:abc');
}

export async function addEntry() {
  return client.add('entry:new', 'value', { expires: 30 });
}

export async function replaceEntry() {
  return client.replace('entry:existing', 'new-value', { expires: 30 });
}

export async function touchKey() {
  return client.touch('session:keep-alive', 60);
}

export async function dynamicKey(key: string) {
  return client.get(key);
}
