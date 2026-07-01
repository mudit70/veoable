import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ArticlesService } from './articles.service';
import type { CreateArticleDto, UpdateArticleDto } from './dto';

@Controller('api/articles')
export class ArticlesController {
  constructor(private readonly svc: ArticlesService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Get(':slug')
  getOne(@Param('slug') slug: string) {
    return this.svc.getBySlug(slug);
  }

  @Post()
  create(@Body() dto: CreateArticleDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateArticleDto) {
    return this.svc.update(id, dto);
  }

  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.svc.publish(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
