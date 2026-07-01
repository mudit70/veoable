// #371 consumer side — imports the coalesce-singleton from another
// file (mirroring formbricks's `apps/web/modules/.../X.ts`).
import { prisma } from './coalesce-producer.js';

export async function listUsersCrossFile() {
  return prisma.user.findMany();
}
