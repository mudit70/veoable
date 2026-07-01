// Vue <script setup> patterns (#57). We use plain .ts file extension
// since the visitor walks the TypeScript AST; Vue SFCs feed their
// script-block contents through the same lang-ts pipeline.

const onMounted = (_cb: () => void): void => {};
const onUpdated = (_cb: () => void): void => {};
const onUnmounted = (_cb: () => void): void => {};
const watch = (_src: unknown, _cb: () => void): void => {};
const watchEffect = (_cb: () => void): void => {};
const ref = <T>(_v: T): { value: T } => ({ value: _v });

const count = ref(0);
const message = ref('hello');

onMounted(() => {
  console.log('mounted');
});

onUpdated(() => {
  console.log('updated');
});

onUnmounted(() => {
  console.log('unmounted');
});

watch(count, () => {
  console.log('count changed');
});

watchEffect(() => {
  console.log('effect:', message.value);
});

export {};
