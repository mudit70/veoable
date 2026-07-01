import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const t = initTRPC.create();
const prisma = new PrismaClient();

const publicProcedure = t.procedure;
const router = t.router;

export const appRouter = router({
  // Query: GET /trpc/listTodos
  listTodos: publicProcedure
    .query(async () => {
      return prisma.todo.findMany();
    }),

  // Query with input: GET /trpc/getTodo
  getTodo: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      return prisma.todo.findUnique({ where: { id: input.id } });
    }),

  // Mutation: POST /trpc/createTodo
  createTodo: publicProcedure
    .input(z.object({ title: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.todo.create({ data: { title: input.title } });
    }),

  // Mutation: POST /trpc/toggleTodo
  toggleTodo: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const todo = await prisma.todo.findUnique({ where: { id: input.id } });
      return prisma.todo.update({
        where: { id: input.id },
        data: { completed: !todo?.completed },
      });
    }),

  // Mutation: POST /trpc/deleteTodo
  deleteTodo: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      return prisma.todo.delete({ where: { id: input.id } });
    }),
});

export type AppRouter = typeof appRouter;
