<script setup lang="ts">
import { ref } from 'vue';
import OrderBook from './components/OrderBook.vue';
import OrderForm from './components/OrderForm.vue';
import PortfolioView from './components/PortfolioView.vue';

const symbol = ref('AAPL');
</script>

<template>
  <header>
    <h1>Trading Dashboard</h1>
    <label>
      Symbol:
      <select v-model="symbol">
        <option value="AAPL">AAPL</option>
        <option value="GOOG">GOOG</option>
        <option value="TSLA">TSLA</option>
      </select>
    </label>
  </header>

  <main style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
    <OrderBook :symbol="symbol" />
    <OrderForm :symbol="symbol" />
  </main>

  <PortfolioView />
</template>
