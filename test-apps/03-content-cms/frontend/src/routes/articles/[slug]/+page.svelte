<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { getArticle, type Article } from '$lib/api';

  let article: Article | null = null;

  onMount(async () => {
    article = await getArticle($page.params.slug);
  });
</script>

{#if article}
  <article>
    <h2>{article.title}</h2>
    <p style="white-space: pre-wrap">{article.body}</p>
  </article>
{:else}
  <p>Loading…</p>
{/if}
