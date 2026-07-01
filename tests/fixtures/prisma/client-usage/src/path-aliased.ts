// Simulates the Next.js path-alias pattern where ts-morph can't
// follow the import (`import prisma from "@/lib/prisma"`) because the
// project's `paths` mapping isn't registered with the type-checker.
//
// We model this by binding `prisma` via `declare const` — the AST
// resolver sees no initializer and returns 'unknown', so the regex
// fallback (#97 path-alias case) is what accepts this call site.
declare const prisma: {
  user: { findMany: () => Promise<unknown> };
  post: { create: (data: unknown) => Promise<unknown> };
};

export async function listUsersViaPathAlias() {
  return prisma.user.findMany();
}

export async function createPostViaPathAlias() {
  return prisma.post.create({ data: { title: 'x' } });
}
