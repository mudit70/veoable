// Knex stub so the fixture compiles standalone.
const knex = Object.assign(
  function (_t: string) {
    const builder = {
      select: (..._c: unknown[]) => Promise.resolve([] as unknown[]),
      first: () => Promise.resolve(null),
      where: (_w: unknown) => builder,
      insert: (_v: unknown) => Promise.resolve([0]),
      update: (_v: unknown) => Promise.resolve(0),
      del: () => Promise.resolve(0),
    };
    return builder;
  },
  { raw: (_q: string) => Promise.resolve([]) },
);

import { USERS_TABLE, POSTS_TABLE, Tables } from './tables.js';

// Identifier-imported const.
export async function listUsers() {
  return knex(USERS_TABLE).select('*');
}

// Local const, same file.
export async function findPost(id: number) {
  const T = POSTS_TABLE;
  return knex(T).where({ id }).first();
}

// Member access on a const object.
export async function listOrders() {
  return knex(Tables.ORDERS).select('*');
}

// Direct string literal (control — should still work).
export async function listSessions() {
  return knex('sessions').select('*');
}

// Unresolvable: arg is a function parameter, no value to fold.
export async function listDynamic(tableName: string) {
  return knex(tableName).select('*');
}
