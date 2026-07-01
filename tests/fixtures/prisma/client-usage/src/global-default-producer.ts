// #368 cross-file producer side — mirrors typebot.io's exact
// shape: `if (!global.prisma) global.prisma = new PrismaClient();
// export default global.prisma;`.
import { PrismaClient } from './prisma-client.js';

declare const global: { prisma?: PrismaClient };

if (!global.prisma) {
  global.prisma = new PrismaClient();
}

export default global.prisma;
