import { Module } from '@nestjs/common';
import { ArticlesModule } from './articles/articles.module';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

@Module({
  imports: [ArticlesModule],
  providers: [PrismaService, RedisService],
  exports: [PrismaService, RedisService],
})
export class AppModule {}
