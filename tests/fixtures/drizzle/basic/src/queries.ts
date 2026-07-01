// Drizzle query call sites. Stubs for db so the fixture compiles.
import { usersTable, postsTable } from './schema.js';

const db = {
  select: () => ({ from: <T>(_t: T) => Promise.resolve([] as unknown[]) }),
  insert: <T>(_t: T) => ({ values: (_v: unknown) => Promise.resolve() }),
  update: <T>(_t: T) => ({ set: (_v: unknown) => ({ where: (_w: unknown) => Promise.resolve() }) }),
  delete: <T>(_t: T) => ({ where: (_w: unknown) => Promise.resolve() }),
  execute: (_sql: unknown) => Promise.resolve(),
};

export async function listUsers() {
  return db.select().from(usersTable);
}

export async function createUser(email: string) {
  return db.insert(usersTable).values({ email });
}

export async function updateUser(id: number, name: string) {
  return db.update(usersTable).set({ name }).where({ id });
}

export async function deleteUser(id: number) {
  return db.delete(usersTable).where({ id });
}

export async function listPosts() {
  return db.select().from(postsTable);
}

export async function runRawQuery() {
  return db.execute('SELECT 1');
}
