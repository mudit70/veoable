<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getPortfolio, type PortfolioPosition } from '../api/client';

const positions = ref<PortfolioPosition[]>([]);

onMounted(async () => {
  positions.value = await getPortfolio();
});
</script>

<template>
  <section>
    <h2>Portfolio</h2>
    <ul>
      <li v-for="p in positions" :key="p.symbol">
        {{ p.symbol }}: {{ p.quantity }} @ ${{ (p.avgCostCents / 100).toFixed(2) }}
      </li>
    </ul>
  </section>
</template>
