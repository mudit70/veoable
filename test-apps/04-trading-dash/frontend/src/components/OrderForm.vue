<script setup lang="ts">
import { ref } from 'vue';
import { placeOrder } from '../api/client';

const props = defineProps<{ symbol: string }>();
const side = ref<'buy' | 'sell'>('buy');
const quantity = ref(1);
const price = ref(100);
const message = ref<string | null>(null);

async function submit() {
  message.value = null;
  await placeOrder({
    symbol: props.symbol,
    side: side.value,
    quantity: quantity.value,
    priceCents: Math.round(price.value * 100),
  });
  message.value = 'Order queued.';
}
</script>

<template>
  <section>
    <h2>Place Order</h2>
    <form @submit.prevent="submit">
      <label>
        Side
        <select v-model="side">
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
      </label>
      <label>Quantity <input type="number" v-model.number="quantity" min="1" /></label>
      <label>Price (USD) <input type="number" v-model.number="price" min="0.01" step="0.01" /></label>
      <button type="submit">Submit</button>
    </form>
    <p v-if="message">{{ message }}</p>
  </section>
</template>
