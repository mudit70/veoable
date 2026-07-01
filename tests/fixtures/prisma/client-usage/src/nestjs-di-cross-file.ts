// #326 — Cross-file NestJS DI: consumer imports PrismaService from
// a sibling file. Mirrors ghostfolio's actual layout.
import { PrismaService } from './prisma-service-extending.js';

export class CrossFileService {
  constructor(private readonly prismaService: PrismaService) {}

  async list() {
    return this.prismaService.user.findMany();
  }
}
