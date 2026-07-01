<script lang="ts">
  import { onMount } from 'svelte';
  import { listArticles, type Article } from '$lib/api';

  let articles: Article[] = [];

  onMount(async () => {
    articles = await listArticles();
  });
</script>

<h2>Recent articles</h2>
<ul>
  {#each articles as a}
    <li>
      <a href={`/articles/${a.slug}`}>{a.title}</a>
      {#if a.publishedAt}
        <span style="color: #999"> ({new Date(a.publishedAt).toLocaleDateString()})</span>
      {:else}
        <span style="color: #c80"> (draft)</span>
      {/if}
    </li>
  {/each}
</ul>
