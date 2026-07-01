export async function loadLazy() {
  const mod = await import('./lazy.js');
  return mod.lazyValue();
}
