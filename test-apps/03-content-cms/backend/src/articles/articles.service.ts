import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
import type { CreateArticleDto, UpdateArticleDto } from './dto';

const LIST_CACHE_KEY = 'articles:all';
const ARTICLE_CACHE_PREFIX = 'article:';

@Injectable()
export class ArticlesService {
  constructor(private prisma: PrismaService, private redis: RedisService) {}

  async list() {
    const cached = await this.redis.getJSON<any[]>(LIST_CACHE_KEY);
    if (cached) return cached;
    const rows = await this.prisma.article.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    await this.redis.setJSON(LIST_CACHE_KEY, rows, 30);
    return rows;
  }

  async getBySlug(slug: string) {
    const key = `${ARTICLE_CACHE_PREFIX}${slug}`;
    const cached = await this.redis.getJSON<any>(key);
    if (cached) return cached;
    const article = await this.prisma.article.findUnique({ where: { slug } });
    if (!article) throw new NotFoundException();
    await this.redis.setJSON(key, article, 120);
    return article;
  }

  async create(dto: CreateArticleDto) {
    const created = await this.prisma.article.create({
      data: { slug: dto.slug, title: dto.title, body: dto.body, authorId: dto.authorId },
    });
    await this.redis.del(LIST_CACHE_KEY);
    return created;
  }

  async update(id: string, dto: UpdateArticleDto) {
    const updated = await this.prisma.article.update({
      where: { id },
      data: { title: dto.title, body: dto.body },
    });
    await this.redis.invalidatePattern(`${ARTICLE_CACHE_PREFIX}*`);
    await this.redis.del(LIST_CACHE_KEY);
    return updated;
  }

  async publish(id: string) {
    const updated = await this.prisma.article.update({
      where: { id },
      data: { publishedAt: new Date() },
    });
    await this.redis.invalidatePattern(`${ARTICLE_CACHE_PREFIX}*`);
    await this.redis.del(LIST_CACHE_KEY);
    return updated;
  }

  async remove(id: string) {
    await this.prisma.article.delete({ where: { id } });
    await this.redis.invalidatePattern(`${ARTICLE_CACHE_PREFIX}*`);
    await this.redis.del(LIST_CACHE_KEY);
  }
}
