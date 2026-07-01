import * as schema from './schema.js';

// Drizzle stub.
type Tx = {
  insert: (table: unknown) => { values: (v: unknown) => Promise<unknown[]> };
  update: (table: unknown) => { set: (v: unknown) => { where: (w: unknown) => Promise<unknown> } };
  select: () => { from: (t: unknown) => Promise<unknown[]> };
};
const db = {
  transaction: <T>(_cb: (tx: Tx) => Promise<T>) => Promise.resolve({} as T),
  insert: (table: unknown) => ({ values: (_v: unknown) => Promise.resolve([] as unknown[]) }),
  update: (table: unknown) => ({
    set: (_v: unknown) => ({ where: (_w: unknown) => Promise.resolve({}) }),
  }),
  select: () => ({ from: (_t: unknown) => Promise.resolve([] as unknown[]) }),
};

// #397 — namespace-imported tables. `schema.users` is a
// PropertyAccessExpression that today doesn't resolve through
// tableNameByIdentifier; the visitor now consults lang-ts's
// resolveNamespaceImportProperty to follow the import to its
// producer file and read the pgTable string-name arg.

export async function createUser(email: string) {
  return db.insert(schema.users).values({ email });
}

export async function listPosts() {
  return db.select().from(schema.posts);
}

export async function updateAudit(id: number, action: string) {
  return db.update(schema.auditLog).set({ action }).where({ id });
}

// tx-bound version exercises the same resolution from inside a
// transaction callback.
export async function txCreateUserAndAudit(email: string, action: string) {
  return db.transaction(async (tx) => {
    await tx.insert(schema.users).values({ email });
    await tx.insert(schema.auditLog).values({ action });
  });
}
