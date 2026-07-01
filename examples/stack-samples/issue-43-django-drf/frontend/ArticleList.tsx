import React, { useEffect, useState } from 'react';

interface Article {
  id: number;
  title: string;
  body: string;
  author: string;
}

export default function ArticleList() {
  const [articles, setArticles] = useState<Article[]>([]);

  useEffect(() => {
    fetch('/api/articles')
      .then((res) => res.json())
      .then(setArticles);
  }, []);

  const handlePublish = async (title: string, body: string) => {
    await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
  };

  return (
    <div>
      <h1>Articles</h1>
      <button onClick={() => handlePublish('Draft', 'Content here')}>Publish</button>
      {articles.map((a) => (
        <article key={a.id}>
          <h2>{a.title}</h2>
          <p>by {a.author}</p>
        </article>
      ))}
    </div>
  );
}
