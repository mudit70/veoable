import { PrismaClient } from './prisma-client.js';

// AST-proved receivers (#6) — variable name does NOT determine
// recognition. All four bindings below resolve to `new PrismaClient()`
// and so are accepted with `confidence: 'direct'`.
const db = new PrismaClient();
const client = new PrismaClient();
const database = new PrismaClient();
const orm = new PrismaClient();

export async function listViaDb() {
  return db.user.findMany();
}

export async function listViaClient() {
  return client.user.findMany();
}

// Non-conventional names — the prior name-regex heuristic dropped
// these silently. AST resolution now picks them up.
export async function listViaDatabase() {
  return database.user.findMany();
}

export async function listViaOrm() {
  return orm.user.findMany();
}

// Class with a `this.prisma` member — another common pattern.
export class UserService {
  private prisma = new PrismaClient();

  async getAll() {
    return this.prisma.user.findMany();
  }

  async create(email: string) {
    return this.prisma.user.create({ data: { email } });
  }
}

// Class with a non-conventionally-named field — also AST-resolved.
export class CustomService {
  private storage = new PrismaClient();

  async list() {
    return this.storage.user.findMany();
  }
}

// Next.js singleton-with-fallback pattern (#312). The initializer is
// a `||` BinaryExpression; the AST resolver unwraps both arms and
// finds `new PrismaClient()` on the right. Should be `direct`
// confidence even though the left arm is unresolvable.
declare const globalPrisma: PrismaClient | undefined;
const singleton = globalPrisma || new PrismaClient();
export async function listViaSingleton() {
  return singleton.user.findMany();
}

// `??` variant — same shape, nullish-coalescing operator.
const nullishSingleton = globalPrisma ?? new PrismaClient();
export async function listViaNullishSingleton() {
  return nullishSingleton.user.findMany();
}

// Ternary variant — both arms inspected; the truthy arm is the
// PrismaClient construction.
const isTest = false;
const ternarySingleton = isTest ? globalPrisma! : new PrismaClient();
export async function listViaTernary() {
  return ternarySingleton.user.findMany();
}

// #317 — Higher-order memoize/remember wrapper. The wrapper takes a
// factory callback and returns its memoized result. The AST resolver
// follows into the callback's return expression to reach the
// underlying `new PrismaClient()`. Documenso's actual pattern.
function remember<T>(_key: string, factory: () => T): T {
  return factory();
}
const rememberedSingleton = remember('prisma', () => new PrismaClient());
export async function listViaRemember() {
  return rememberedSingleton.user.findMany();
}

// #317 — concise-body arrow (no block, no explicit return).
function memoize<T>(factory: () => T): T {
  return factory();
}
const memoizedSingleton = memoize(() => new PrismaClient());
export async function listViaMemoize() {
  return memoizedSingleton.user.findMany();
}

// #317 — block-body callback with intermediate logic; the resolver
// follows the last `return` statement.
const blockBodySingleton = remember('block', () => {
  const c = new PrismaClient();
  return c;
});
export async function listViaBlockBody() {
  return blockBodySingleton.user.findMany();
}

// #320 — block body with EARLY RETURN. The previous "last-return-
// wins" rule would have only seen the trailing `return mock`
// branch and bailed; the descendants-walk picks up the early
// `return new PrismaClient()` arm too.
const mockClient = { user: { findMany: () => [] } } as unknown as PrismaClient;
const isProduction = true;
const earlyReturnSingleton = remember('early', () => {
  if (isProduction) return new PrismaClient();
  return mockClient;
});
export async function listViaEarlyReturn() {
  return earlyReturnSingleton.user.findMany();
}

// #320 — `as`-cast. The resolver unwraps the assertion and finds
// the inner construction.
const castSingleton = new PrismaClient() as PrismaClient;
export async function listViaCast() {
  return castSingleton.user.findMany();
}

// #320 — non-null assertion. Same idea — unwrap and recurse.
const nonNullSingleton = (globalPrisma ?? new PrismaClient())!;
export async function listViaNonNull() {
  return nonNullSingleton.user.findMany();
}

// #320 — `await` should not crash even when it can't resolve.
async function getPrismaAsync(): Promise<PrismaClient> {
  return new PrismaClient();
}
async function loadAsync() {
  const awaitedClient = await getPrismaAsync();
  return awaitedClient.user.findMany();
}
export { loadAsync };

// #321 review C1 — nested CALLABLE scopes (accessor / constructor
// inside the factory body) must NOT leak their `return` statements
// into the outer classification. Pre-fix, `forEachDescendant` walked
// into the getter's body and saw `return new PrismaClient()`, so
// `leakyAccessorSingleton` was mis-classified as `'client'` and any
// CRUD-method-shaped call against it emitted a false-positive
// Prisma DatabaseInteraction. Post-fix the resolver skips
// `GetAccessorDeclaration`/`SetAccessorDeclaration`/`ConstructorDeclaration`
// so only the factory's actual return value (`helper`, a plain
// object literal) is examined → 'unresolved' → no false positive.
const leakyAccessorSingleton = remember('leak-accessor', () => {
  const helper = {
    get cached() {
      return new PrismaClient();
    },
    user: { findMany: () => [] },
  };
  return helper;
});
export function listViaLeakyAccessor() {
  // Pre-fix this would have emitted a spurious READS edge to User.
  // Post-fix the receiver is unresolved and the regex doesn't
  // match `leakyAccessorSingleton`, so no DBI is emitted.
  return leakyAccessorSingleton.user.findMany();
}
