// #368 cross-file consumer side — `import prisma from "./..."`
// (default import). Mirrors typebot.io's
// `import prisma from "@typebot.io/prisma"` shape.
import prisma from './global-default-producer.js';

export async function listUsersCrossFileGlobal() {
  return prisma.user.findMany();
}
