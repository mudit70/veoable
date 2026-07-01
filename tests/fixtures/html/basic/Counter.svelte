<script lang="ts">
  import { onMount } from 'svelte';
  import { incrementCounter, fetchCounter } from '../api/counter';

  let count = 0;

  onMount(async () => { count = await fetchCounter(); });

  // The `<` comparison below must NOT be entered as an HTML tag by the
  // brace-wrapping preprocessor. If it were, the next `=` followed by
  // `{ ... }` would get quoted, corrupting this script.
  async function handleClick() {
    if (count<10) {
      count = await incrementCounter();
    }
  }

  function handleSubmit() {
    handleClick();
  }
</script>

<!-- Comment with on:click={fake} that must NOT trigger rewriting. -->

<button on:click={handleClick}>Bare ref</button>
<button on:click={() => handleClick()}>Inline arrow</button>
<button on:click|preventDefault={handleSubmit}>With modifier</button>
<input bind:value={count} />
