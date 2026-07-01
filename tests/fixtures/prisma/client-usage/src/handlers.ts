import { PrismaClient } from './prisma-client.js';

const prisma = new PrismaClient();

// Canonical receiver name + read operation
export async function listUsers() {
  return prisma.user.findMany();
}

// Canonical receiver + unique read
export async function getUserById(id: number) {
  return prisma.user.findUnique({ where: { id } });
}

// Canonical receiver + write (create)
export async function createUser(email: string, name: string) {
  return prisma.user.create({ data: { email, name } });
}

// Canonical receiver + update
export async function renameUser(id: number, name: string) {
  return prisma.user.update({ where: { id } as const, data: { name } });
}

// Canonical receiver + delete
export async function removeUser(id: number) {
  return prisma.user.delete({ where: { id } });
}

// Canonical receiver + upsert
export async function upsertUser(email: string, name: string) {
  return prisma.user.upsert({
    where: { email } as const,
    create: { email, name },
    update: { name },
  });
}

// Canonical receiver + count (read)
export async function countUsers() {
  return prisma.user.count();
}

// Canonical receiver + raw query
export async function rawQuery() {
  return prisma.$queryRaw`SELECT * FROM "User"`;
}

// Call on a second model
export async function listPosts() {
  return prisma.post.findMany();
}
