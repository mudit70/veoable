import { PrismaClient } from './prisma-client.js';

const prisma = new PrismaClient();

// Module-top-level call site (no enclosing function). The visitor
// must silently drop these — there's no FunctionDefinition to
// attribute the interaction to.
void prisma.user.findMany();

// await-wrapped call — the CallExpression is inside an AwaitExpression.
// The walker should still visit the inner CallExpression.
export async function awaited() {
  const users = await prisma.user.findMany();
  return users;
}

// Two identical call sites in the SAME function. Because the interaction
// id is content-addressed on (function, operation, table), these collapse
// to ONE DatabaseInteraction node and ONE READS edge.
export async function duplicateWithinFunction() {
  const a = await prisma.user.findMany();
  const b = await prisma.user.findMany();
  return [a, b];
}

// Same call in a DIFFERENT function should produce a DISTINCT interaction
// (different enclosing function id → different interaction id).
export async function distinctFunction() {
  return prisma.user.findMany();
}

// $transaction callback — calls inside use a `tx` receiver bound to
// the same PrismaClient as the outer receiver. The visitor walks up
// from the parameter declaration to the `.$transaction` call and
// recurses on its receiver, so `tx.<model>.<op>()` is detected as a
// direct-confidence interaction (#388).
export async function inTransaction() {
  return prisma.$transaction(async (tx) => {
    return tx.user.findMany();
  });
}

// A raw query longer than 500 characters so the truncation path is
// exercised. The literal is padded with filler to cross the boundary.
/* eslint-disable */
// prettier-ignore
export async function longRawQuery() {
  return prisma.$queryRawUnsafe('SELECT * FROM "User" WHERE note = \'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\'');
}
/* eslint-enable */
