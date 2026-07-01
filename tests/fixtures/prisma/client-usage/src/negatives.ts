// Calls that look prisma-ish but should NOT produce DatabaseInteractions.
import { PrismaClient } from './prisma-client.js';

const prisma = new PrismaClient();

// Unknown CRUD method — not in the whitelist.
export async function unknownMethod() {
  // @ts-expect-error — not a real Prisma method
  return prisma.user.fakeMethod();
}

// Computed access — dynamic shape.
export async function computedAccess(modelName: 'user') {
  // @ts-expect-error — runtime access
  return prisma[modelName].findMany();
}

// A three-level access on a non-Prisma receiver.
const something = { user: { findMany: () => [] } };
export function unrelatedCall() {
  return something.user.findMany();
}

// Standalone function call, no chain.
export function unrelatedFn() {
  return [1, 2, 3].map((x) => x * 2);
}

// #97 — mixed-ORM false-positive guard. `db` is a conventional
// Prisma name BUT AST resolution proves it's a Mongo client. The
// resolver returns 'not-prisma' (definitive negative); the visitor
// must NOT fall back to the legacy name regex.
class MongoClient {
  user = { findMany: () => [] };
}
const db = new MongoClient();
export function mixedOrmFalsePositive() {
  return db.user.findMany();
}

// #317 — HOF-wrapped mixed-ORM guard. The outer wrapper is the
// allowlisted `remember(...)` HOF; recursing into the callback
// reaches `new MongoClient()` — definitively not Prisma. The
// resolver must propagate `'not-prisma'` through the HOF unwrap
// and the visitor must NOT fall back to the regex even though
// `dbInsideHof` matches the conventional name shape.
function rememberHof<T>(_key: string, factory: () => T): T {
  return factory();
}
const dbInsideHof = rememberHof('mongo', () => new MongoClient());
export function hofMixedOrmFalsePositive() {
  return dbInsideHof.user.findMany();
}
