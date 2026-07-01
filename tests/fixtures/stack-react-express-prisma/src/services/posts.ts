// #313 — Non-conventional receiver names that exercise the AST
// resolver paths. Pre-#5/#6 these would have been silently dropped
// (the legacy receiver-name regex only matched `prisma|db|client`).
//
// Each binding below is bound to `new PrismaClient()` (transitively
// through the `database` re-export and the class field). The AST
// resolver follows the chain and classifies them as `'client'` →
// `confidence: 'direct'`.

import { PrismaClient } from '../stubs/prisma-client.js';

// Non-conventional module-level binding.
const database = new PrismaClient();

export async function listPostsViaDatabase() {
  return database.post.findMany();
}

// Class field with a non-conventional name (`storage`, not `prisma`).
export class PostService {
  private readonly storage = new PrismaClient();

  async listAll() {
    return this.storage.post.findMany();
  }

  async create(title: string) {
    return this.storage.post.create({ data: { title } });
  }
}
