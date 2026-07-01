export interface Article {
  id: string;
  slug: string;
  title: string;
  body: string;
  publishedAt: string | null;
}

export async function listArticles(): Promise<Article[]> {
  const res = await fetch('/api/articles');
  if (!res.ok) throw new Error('Failed to load articles');
  return res.json();
}

export async function getArticle(slug: string): Promise<Article | null> {
  const res = await fetch(`/api/articles/${slug}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to load article');
  return res.json();
}

export async function createArticle(input: { slug: string; title: string; body: string }): Promise<Article> {
  const res = await fetch('/api/articles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to create article');
  return res.json();
}

export async function publishArticle(id: string): Promise<Article> {
  const res = await fetch(`/api/articles/${id}/publish`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to publish');
  return res.json();
}
