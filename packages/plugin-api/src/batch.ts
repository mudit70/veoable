import { SCHEMA_VERSION, type NodeBatch } from '@adorable/schema';

export type { NodeBatch };

/**
 * Metadata stamped on every `NodeBatch` committed to the graph store. The
 * store uses this to attribute nodes to their producing plugin and to
 * refuse batches built against an incompatible schema version.
 */
export interface BatchMeta {
  /**
   * The schema version the producing plugin was built against. Always
   * pinned to `SCHEMA_VERSION` at the moment of construction via
   * `makeBatchMeta`; do not hand-roll this field.
   */
  schemaVersion: string;
  /** The plugin id that produced the batch (e.g. `'ts'`, `'express'`, `'prisma'`). */
  producedBy: string;
  /** ISO-8601 timestamp at which the batch was constructed. */
  producedAt: string;
}

/**
 * Construct a `BatchMeta` for a batch being emitted right now. Always
 * stamps `schemaVersion` with the current `SCHEMA_VERSION` constant so a
 * schema bump surfaces automatically in every plugin without code changes.
 */
export function makeBatchMeta(producedBy: string): BatchMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    producedBy,
    producedAt: new Date().toISOString(),
  };
}

/** Construct an empty `NodeBatch`. Convenience for plugins that accumulate incrementally. */
export function emptyBatch(): NodeBatch {
  return { nodes: [], edges: [] };
}
