<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { listOrders, cancelOrder, type Order } from '../api/client';

const props = defineProps<{ symbol: string }>();
const orders = ref<Order[]>([]);

async function refresh() {
  orders.value = await listOrders(props.symbol);
}

async function handleCancel(id: string) {
  await cancelOrder(id);
  await refresh();
}

onMounted(refresh);
watch(() => props.symbol, refresh);
</script>

<template>
  <section>
    <h2>Order Book — {{ symbol }}</h2>
    <table>
      <thead>
        <tr>
          <th>Side</th>
          <th>Qty</th>
          <th>Price</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="o in orders" :key="o.id">
          <td>{{ o.side }}</td>
          <td>{{ o.quantity }}</td>
          <td>${{ (o.priceCents / 100).toFixed(2) }}</td>
          <td>{{ o.status }}</td>
          <td>
            <button v-if="o.status === 'pending'" @click="handleCancel(o.id)">Cancel</button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
