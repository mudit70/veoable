// #326 — NestJS DI-injected services. The PrismaService class
// extends PrismaClient; consumer services declare it as a
// constructor parameter property. Pre-fix the AST resolver bailed
// because there's no initializer or assignment for the field.
// Post-fix the type annotation is followed to PrismaService, which
// is then classified as `'client'` because it extends PrismaClient.
import { PrismaClient } from './prisma-client.js';

export class PrismaService extends PrismaClient {
  // Real PrismaService would have onModuleInit/onModuleDestroy etc.
  // The base-class extension is what matters for receiver detection.
}

export class UserDIService {
  constructor(private readonly prismaService: PrismaService) {}

  async list() {
    return this.prismaService.user.findMany();
  }

  async create(email: string) {
    return this.prismaService.user.create({ data: { email } });
  }
}

// Plain typed field (no initializer; assigned via DI elsewhere).
export class UserDIService2 {
  private readonly prisma!: PrismaService;

  async list() {
    return this.prisma.user.findMany();
  }
}

// Negative-proof: a DI-injected service whose type wraps a
// definitively-not-Prisma client must NOT trigger the regex
// fallback even though `db` matches the canonical regex.
// The chain CustomDb → `new MongoDriver()` is a `'not-prisma'`
// (NewExpression with a non-PrismaClient constructor name) and
// must propagate through the type-annotation path.
class MongoDriver {
  user = { findMany: () => [] };
}
class CustomDb {
  driver = new MongoDriver();
  user = this.driver.user;
}

export class MixedOrmService {
  constructor(private readonly db: CustomDb) {}

  async list() {
    return this.db.user.findMany();
  }
}
