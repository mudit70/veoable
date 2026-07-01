import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const resolvers = {
  Query: {
    books: async () => {
      return prisma.book.findMany();
    },
    book: async (_parent: unknown, args: { id: number }) => {
      return prisma.book.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    addBook: async (_parent: unknown, args: { title: string; author: string }) => {
      return prisma.book.create({ data: { title: args.title, author: args.author } });
    },
    deleteBook: async (_parent: unknown, args: { id: number }) => {
      return prisma.book.delete({ where: { id: args.id } });
    },
  },
};
