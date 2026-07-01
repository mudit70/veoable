// #307 — Function-parameter DI receivers. The receiver lands on
// a `ParameterDeclaration`; the resolver follows the type
// annotation. Three flavors mirroring real codebases:
import { PrismaClient } from './prisma-client.js';

// 1. Plain `PrismaClient` parameter — the simplest pattern.
export async function listUsersDirect(prisma: PrismaClient) {
  return prisma.user.findMany();
}

// 2. Class extending PrismaClient as the parameter type. Same
//    extends-chain logic as #326 but reached via a plain
//    function parameter rather than a class field.
class PrismaService extends PrismaClient {}
export async function listUsersExtending(prisma: PrismaService) {
  return prisma.user.findMany();
}

// 3. `ReturnType<typeof factory>` alias wrapping a `$extends`
//    chain. Mirrors test-code-comprehension's
//    `ExtendedPrismaClient = ReturnType<typeof extendPrismaClient>`.
function extendPrismaClient() {
  const prisma = new PrismaClient();
  return prisma.$extends({ name: 'returntype-typeof' });
}
type ExtendedPrismaClient = ReturnType<typeof extendPrismaClient>;
export async function listUsersExtended(prisma: ExtendedPrismaClient) {
  return prisma.user.findMany();
}

// 4. Type alias chain pointing at PrismaClient directly. The
//    resolver should follow the alias to its right-hand side.
type DbClient = PrismaClient;
export async function listUsersAliased(prisma: DbClient) {
  return prisma.user.findMany();
}
