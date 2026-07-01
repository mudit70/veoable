import type Database from 'better-sqlite3';

/**
 * Canonical schema layer (#67).
 *
 * Creates the three tables that back `SQLiteCanonicalGraphStore`:
 *
 * - `canonical_nodes` — every `SchemaNode` from `@veoable/schema`,
 *   keyed by the content-addressed id from `idFor.*`. The full node JSON
 *   lives in `data` so plugins can round-trip without information loss.
 * - `canonical_edges` — every `SchemaEdge`. Edges have no ids in the
 *   schema package itself; the store derives a content-addressed id from
 *   the canonical JSON of the edge so identical edges (same shape, same
 *   values) collide into one row, making `commit` idempotent.
 * - `batches` — one row per `commit` call, recording `BatchMeta` so we
 *   can attribute every node/edge to its producing plugin and refuse
 *   batches built against an incompatible schema version on read.
 *
 * The migration is additive and idempotent (`IF NOT EXISTS` everywhere),
 * so it can be re-run safely against an existing database.
 */
export function migrateCanonical(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version TEXT NOT NULL,
      produced_by TEXT NOT NULL,
      produced_at TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      edge_count INTEGER NOT NULL,
      committed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS canonical_nodes (
      id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      data TEXT NOT NULL,
      batch_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (batch_id) REFERENCES batches(id)
    );

    CREATE TABLE IF NOT EXISTS canonical_edges (
      id TEXT PRIMARY KEY,
      edge_type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      data TEXT NOT NULL,
      batch_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (batch_id) REFERENCES batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_canonical_nodes_type ON canonical_nodes(node_type);
    CREATE INDEX IF NOT EXISTS idx_canonical_edges_type ON canonical_edges(edge_type);
    CREATE INDEX IF NOT EXISTS idx_canonical_edges_from ON canonical_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_canonical_edges_to ON canonical_edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_canonical_edges_from_type ON canonical_edges(from_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_canonical_edges_to_type ON canonical_edges(to_id, edge_type);

    CREATE TABLE IF NOT EXISTS project_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- #294 Phase 2a — per-file content hashes for incremental analyze.
    -- Keyed by (repository, file_path). The hash is a sha256 of the
    -- file's bytes at the time of the last successful extraction.
    -- Used by --incremental to determine which files changed since
    -- the previous run. Schema-version-tagged so a schema bump
    -- invalidates the cache.
    CREATE TABLE IF NOT EXISTS source_file_hashes (
      repository TEXT NOT NULL,
      file_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repository, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_source_file_hashes_repo ON source_file_hashes(repository);
  `);
}
