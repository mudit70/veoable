// File without memjs import — must produce zero emits.

const fakeStore = new Map<string, string>();

export function localLookup() {
  return fakeStore.get('not-memcache');
}
