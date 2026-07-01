// #327 — `pages/api/_get.ts` is a private helper consumed by a
// sibling parent file (e.g. `index.ts`). It must NOT be emitted
// as an endpoint despite having a default export.
export default async function getHandler() {
  return { ok: true };
}
