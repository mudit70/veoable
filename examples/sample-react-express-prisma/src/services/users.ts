import { prisma } from '../lib/prisma.js';

export async function listUsers() {
  return prisma.user.findMany();
}

export async function getUserById(id: number) {
  return prisma.user.findUnique({ where: { id } });
}

export async function createUser(email: string, name: string | null) {
  return prisma.user.create({ data: { email, name } });
}

export async function updateUser(id: number, data: { email?: string; name?: string | null }) {
  return prisma.user.update({ where: { id }, data });
}

export async function deleteUser(id: number) {
  return prisma.user.delete({ where: { id } });
}
