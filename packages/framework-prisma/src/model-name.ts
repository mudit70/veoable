/**
 * Prisma Client exposes each model under a lower-first-letter accessor
 * on the client instance:
 *
 *   model User         → prisma.user
 *   model HTTPRequest  → prisma.hTTPRequest
 *   model PDFDocument  → prisma.pDFDocument
 *
 * The inverse transformation is "capitalize the first character only."
 * This is the stable Prisma convention and is what we use to map an
 * accessor property name back to the canonical `DatabaseTable.name`
 * the schema parser emitted.
 */
export function modelNameFromAccessor(accessor: string): string {
  if (accessor.length === 0) return accessor;
  return accessor[0].toUpperCase() + accessor.slice(1);
}
