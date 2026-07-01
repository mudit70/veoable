/**
 * Schema version. Bumped on any breaking change to node or edge shapes.
 *
 * The graph store records this version on every batch it ingests. Consumers
 * can refuse to read batches built against an incompatible major version.
 */
export const SCHEMA_VERSION = '0.3.0' as const;
