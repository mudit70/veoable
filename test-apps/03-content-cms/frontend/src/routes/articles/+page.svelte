<script lang="ts">
  import { onMount } from 'svelte';
  import { listArticles, createArticle, publishArticle, type Article } from '$lib/api';

  let articles: Article[] = [];
  let slug = '';
  let title = '';
  let body = '';

  onMount(async () => { articles = await listArticles(); });

  async function handleCreate() {
    const created = await createArticle({ slug, title, body });
    articles = [created, ...articles];
    slug = ''; title = ''; body = '';
  }

  async function handlePublish(id: string) {
    const updated = await publishArticle(id);
    articles = articles.map((a) => (a.id === id ? updated : a));
  }
</script>

<h2>All articles</h2>

<form on:submit|preventDefault={handleCreate} style="margin-bottom: 1rem;">
  <input bind:value={slug} placeholder="slug" required />
  <input bind:value={title} placeholder="title" required />
  <textarea bind:value={body} placeholder="body" rows="4" required></textarea>
  <button type="submit">Create</button>
</form>

<ul>
  {#each articles as a}
    <li>
      <a href={`/articles/${a.slug}`}>{a.title}</a>
      {#if !a.publishedAt}
        <button on:click={() => handlePublish(a.id)}>Publish</button>
      {/if}
    </li>
  {/each}
</ul>
