// Probes that the dynamic-import resolver finds files for several
// extensions, and that a non-string-literal specifier is silently
// skipped (no edge, no crash).
export async function loadAll(): Promise<void> {
  await import('./a.tsx');
  await import('./b.mjs');
  await import('./c.cjs');
  const dyn: string = './d.js';
  await import(dyn);
}
