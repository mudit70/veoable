<!--
  Vue component — patterns a framework-vue visitor must detect

  Detection targets:
    @click → ClientSideProcess(event_handler)
    onMounted() → ClientSideProcess(lifecycle_hook)
    ref() → state management
    axios.get/post → ClientSideAPICaller (already detectable via framework-axios)
-->
<template>
  <div>
    <h1>Contacts</h1>
    <button @click="handleAdd">Add Contact</button>
    <div v-for="contact in contacts" :key="contact.id">
      <span>{{ contact.name }} - {{ contact.email }}</span>
      <button @click="handleDelete(contact.id)">Delete</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import axios from 'axios';

interface Contact {
  id: number;
  name: string;
  email: string;
}

const contacts = ref<Contact[]>([]);

onMounted(async () => {
  const { data } = await axios.get('/api/contacts');
  contacts.value = data;
});

const handleAdd = async () => {
  const { data } = await axios.post('/api/contacts', {
    name: 'New Contact',
    email: 'new@example.com',
  });
  contacts.value.push(data);
};

const handleDelete = async (id: number) => {
  await axios.delete(`/api/contacts/${id}`);
  contacts.value = contacts.value.filter((c) => c.id !== id);
};
</script>
