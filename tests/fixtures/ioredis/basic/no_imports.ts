// File without an ioredis / redis import — must produce zero emits
// even though it happens to have .get() calls on a Map-like object.

const fakeStore = new Map<string, string>();

export function localLookup() {
  return fakeStore.get('not-a-redis-key');
}
