import { prisma } from '../lib/prisma.js';

export async function listPostsByUser(authorId: number) {
  return prisma.post.findMany({ where: { authorId } });
}

export async function createPost(authorId: number, title: string, content: string | null) {
  return prisma.post.create({ data: { title, content, authorId } });
}

export async function deletePost(id: number) {
  return prisma.post.delete({ where: { id } });
}
