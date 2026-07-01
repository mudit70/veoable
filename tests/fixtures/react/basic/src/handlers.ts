// #4 — handlers in their own file, imported by JSX components.
// Exercises the cross-file `TRIGGERS` edge resolution.

export function handleRefresh() {
  // No-op body; the test only checks edge wiring, not the body.
  return null;
}

export const handleSubmit = () => {
  return null;
};

// Default export — exercises the type-checker-first path (the
// syntactic walk would look up `'default'` rather than the local
// alias name, so `getExportedDeclarations().get(handlerName)`
// alone misses this).
export default function handleDefault() {
  return null;
}
