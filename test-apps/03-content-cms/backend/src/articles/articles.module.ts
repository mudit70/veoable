import { Module } from '@nestjs/common';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';

@Module({
  controllers: [ArticlesController],
  providers: [ArticlesService, PrismaService, RedisService],
})
export class ArticlesModule {}
