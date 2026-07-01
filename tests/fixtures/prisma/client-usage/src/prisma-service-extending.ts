// #326 — Cross-file PrismaService that consumers import. Mirrors
// ghostfolio / NestJS pattern.
import { PrismaClient } from './prisma-client.js';

export class PrismaService extends PrismaClient {}
