// #307 — Prisma `$extends(...)` extension pattern. The official
// extension API returns a wrapped client whose model accessors
// behave identically to the inner client; the resolver must
// recurse through one or more `.$extends(...)` layers.
import { PrismaClient } from './prisma-client.js';

// 1. Direct: `new PrismaClient().$extends(ext).<model>.<op>()`.
const direct = new PrismaClient().$extends({ name: 'log' });
export async function listViaDirectExtends() {
  return direct.user.findMany();
}

// 2. Chained: two consecutive `$extends` calls — resolver peels
//    each layer until it reaches `new PrismaClient()`.
const chained = new PrismaClient()
  .$extends({ name: 'one' })
  .$extends({ name: 'two' });
export async function listViaChainedExtends() {
  return chained.user.findMany();
}

// 3. Identifier receiver: factory returns a `$extends`-wrapped
//    client. Combined with #307's parameter type-following, the
//    function `extendPrismaClient` becomes the canonical pattern.
function extendPrismaClient() {
  const prisma = new PrismaClient();
  return prisma.$extends({ name: 'identifier-receiver' });
}
const extended = extendPrismaClient();
export async function listViaFactoryReturn() {
  return extended.user.findMany();
}
