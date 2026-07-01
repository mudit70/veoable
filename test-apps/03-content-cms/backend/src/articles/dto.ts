export interface CreateArticleDto {
  slug: string;
  title: string;
  body: string;
  authorId?: string;
}

export interface UpdateArticleDto {
  title?: string;
  body?: string;
}
