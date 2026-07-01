<template>
  <div class="login">
    <h1>Sign in</h1>
    <form @submit.prevent="onSubmit">
      <input v-model="username" @focus="onFocus" />
      <input type="password" v-model="password" />
      <button type="submit" @click="trackClick">Sign in</button>
    </form>

    <button v-on:click="openHelp" v-on:mouseover="showTooltip">Help</button>
  </div>
</template>

<script>
export default {
  data() {
    return { username: '', password: '' };
  },
  methods: {
    onSubmit() {},
    onFocus() {},
    trackClick() {},
    openHelp() {},
    showTooltip() {},
  },
};
</script>
