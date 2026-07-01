import { usersTable, postsTable } from './schema.js';

// Drizzle stub so the fixture compiles standalone.
type Tx = {
  insert: (table: unknown) => { values: (v: unknown) => Promise<unknown[]> };
  update: (table: unknown) => { set: (v: unknown) => { where: (w: unknown) => Promise<unknown> } };
  delete: (table: unknown) => { where: (w: unknown) => Promise<unknown> };
  select: () => { from: (t: unknown) => Promise<unknown[]> };
};
const db = {
  transaction: <T>(_cb: (tx: Tx) => Promise<T>) => Promise.resolve({} as T),
  insert: (table: unknown) => ({ values: (_v: unknown) => Promise.resolve([] as unknown[]) }),
  select: () => ({ from: (_t: unknown) => Promise.resolve([] as unknown[]) }),
};

// db.transaction callback — tx-bound calls must be recognised as
// drizzle receivers (#387).
export async function createUserAndPost(email: string, title: string) {
  return db.transaction(async (tx) => {
    await tx.insert(usersTable).values({ email });
    await tx.insert(postsTable).values({ title });
  });
}

export async function updateUserInTx(id: number, email: string) {
  return db.transaction(async (tx) => {
    return tx.update(usersTable).set({ email }).where({ id });
  });
}

export async function selectInTx() {
  return db.transaction(async (tx) => {
    return tx.select().from(usersTable);
  });
}

// Control: a direct db.insert (already supported) — must still emit.
export async function plainInsert(email: string) {
  return db.insert(usersTable).values({ email });
}

// #400 — nested transaction savepoint. tx2 binds to tx, which binds
// to myDb; the visitor's recursive receiver check must walk back to
// the outer client (matching DB_RECEIVER_RE via its `Db` suffix) to
// accept `tx2.insert(...)`.
type TxNested = Tx & {
  transaction: <T>(_cb: (tx2: Tx) => Promise<T>) => Promise<T>;
};
const myDb = db as unknown as {
  transaction: <T>(cb: (tx: TxNested) => Promise<T>) => Promise<T>;
  insert: typeof db.insert;
  select: typeof db.select;
};

export async function nestedSavepoint(email: string, title: string) {
  return myDb.transaction(async (tx) => {
    await tx.insert(usersTable).values({ email });
    await tx.transaction(async (tx2) => {
      await tx2.insert(postsTable).values({ title });
      await tx2.update(usersTable).set({ email }).where({ id: 1 });
    });
  });
}
