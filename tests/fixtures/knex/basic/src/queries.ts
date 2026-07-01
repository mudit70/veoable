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
      count: () => Promise.resolve([{ count: 0 }]),
    };
    return builder;
  },
  { raw: (_q: string, _p?: unknown[]) => Promise.resolve([]) },
);

export async function listUsers() {
  return knex('users').select('*');
}

export async function findUser(id: number) {
  return knex('users').where({ id }).first();
}

export async function createUser(email: string) {
  return knex('users').insert({ email });
}

export async function updateUserName(id: number, name: string) {
  return knex('users').where({ id }).update({ name });
}

export async function deleteOrder(id: number) {
  return knex('orders').where({ id }).del();
}

export async function countPosts() {
  return knex('posts').count();
}

export async function rawQuery() {
  return knex.raw('SELECT * FROM users WHERE id = ?', [1]);
}
