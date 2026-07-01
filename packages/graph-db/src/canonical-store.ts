import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  SCHEMA_VERSION,
  validateEdge,
  validateNode,
  type EdgeType,
  type NodeType,
  type SchemaEdge,
  type SchemaNode,
} from '@veoable/schema';
import type { BatchMeta, NodeBatch } from '@veoable/plugin-api';
import { migrateCanonical } from './migrations/002-canonical.js';

/**
 * The canonical graph store contract (#67).
 *
 * This is the interface every plugin, the flow stitcher (#4), and the
 * detection agents code against. It is the only graph store in the
 * workspace; the legacy `GraphStore` and its consumers were removed in
 * #67 part 3/3.
 *
 * The surface is intentionally minimal:
 * - `commit` is the only mutation entry point. Plugins emit `NodeBatch`
 *   values; they never call lower-level inserts.
 * - `getNode` / `findNodes` / `findEdges` are read primitives.
 * - Path traversal (`walkFrom`, `shortestPath`, …) is omitted on
 *   purpose. It will be added when the flow stitcher (#4) actually
 *   needs it, not before.
 */
export interface CanonicalGraphStore {
  /**
   * Commit a batch transactionally and idempotently. Validates every
   * node and edge via `@veoable/schema` first; on any validation
   * failure the entire transaction rolls back and a
   * `SchemaValidationError` is thrown. Identical content (same node
   * id, same edge content hash) committed twice is a no-op on the
   * second commit — the row is updated in place rather than
   * duplicated.
   */
  commit(batch: NodeBatch, meta: BatchMeta): void;

  /**
   * Look up a single node by its content-addressed id, requiring its
   * `nodeType` to match `type`. Returns `null` if not found or if a
   * node with that id exists but has a different type.
   */
  getNode<T extends NodeType>(type: T, id: string): Extract<SchemaNode, { nodeType: T }> | null;

  /**
   * Look up a single node by its content-addressed id without
   * requiring a type. Returns `null` if not found.
   */
  getNodeById(id: string): SchemaNode | null;

  /**
   * Find all nodes of `type` whose top-level fields match every entry
   * in `where`. Filtering is exact-match on JSON-serialized values.
   * Empty `where` returns every node of the type.
   */
  findNodes<T extends NodeType>(
    type: T,
    where?: Partial<Extract<SchemaNode, { nodeType: T }>>
  ): Extract<SchemaNode, { nodeType: T }>[];

  /**
   * Find edges by source, target, or both. Either endpoint may be
   * `null` to wildcard it. The optional `type` filter restricts to a
   * single edge type.
   */
  findEdges(from: string | null, to: string | null, type?: EdgeType): SchemaEdge[];

  /**
   * Return the metadata of every batch ever committed, ordered by
   * commit time ascending. Used by tests and the eventual
   * version-mismatch read check.
   */
  listBatches(): Array<BatchMeta & { id: number; nodeCount: number; edgeCount: number }>;

  /**
   * Delete all nodes (and their associated edges) whose `repository`
   * field matches the given value. Used for clean re-analysis of a
   * single repo in a multi-repo project.
   */
  deleteByRepository(repository: string): { deletedNodes: number; deletedEdges: number };

  /**
   * Merge `DatabaseTable` nodes with `declaredIn === null` (synthesised
   * by a receiver-name heuristic) into canonical `DatabaseTable` nodes
   * with `declaredIn !== null` (discovered from an entity decorator)
   * when they refer to the same logical entity. Used to dedupe
   * `AppVersion`/`appVersion`/`app_versions` style triplets that the
   * order-dependent visitor closure cannot catch alone (#384). The
   * inferred-side names are matched against a generated alias set
   * (camelCase, snake_case, singular/plural) of every canonical name in
   * the same system; on match the function rewrites canonical_edges
   * (`from_id` and `to_id` both) so DBI → table links survive, then
   * deletes the inferred row. DBI node ids remain stable (they hash
   * targetTableId at emission, but downstream consumers traverse via
   * edges, so the hash drift is invisible).
   */
  mergeAliasedDatabaseTables(): { mergedTables: number; rewrittenEdges: number };

  /**
   * Delete `DatabaseSystem` nodes (and their associated edges) that
   * have no `DatabaseTable` children. Used as a post-analysis sweep
   * to prevent framework plugins from polluting the graph with
   * activated-but-empty database systems (#385).
   */
  pruneEmptyDatabaseSystems(): { deletedSystems: number; deletedEdges: number };

  /**
   * Return all distinct repository names with per-type node counts.
   * Only counts node types that carry a direct `repository` field
   * (SourceFile, APIEndpoint, ClientSideAPICaller, ClientSideProcess).
   */
  listRepositories(): Array<{
    repository: string;
    sourceFiles: number;
    endpoints: number;
    clientApiCalls: number;
    clientProcesses: number;
  }>;

  /**
   * Project-level key/value metadata (#255). Persists configuration
   * that should outlive a single CLI run so MCP tools can re-apply it
   * (e.g., the `applications` declaration so MCP `stitch` can rebuild
   * the `ApplicationScope` without the user re-passing the config).
   */
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;

  /**
   * #294 Phase 2a — incremental analyze support.
   *
   * Delete all nodes (and their edges) for a single source file.
   * Mirrors `deleteByRepository` but at file granularity. Identifies
   * nodes both directly via the `repository` + `filePath` fields on
   * SourceFile, and indirectly via `sourceFileId` (FunctionDefinition,
   * DatabaseInteraction, ClientSideAPICaller, ClientSideProcess,
   * Screen, etc.) and `handlerFunctionId` / `functionId` follow-ons.
   */
  deleteByFile(repository: string, filePath: string): { deletedNodes: number; deletedEdges: number };

  /**
   * #294 Phase 2a — get the stored content hash for a (repository,
   * filePath) pair. Returns null when no hash has been recorded yet
   * (file is new since the last `--incremental` run or the cache
   * was invalidated by a schema bump).
   */
  getSourceFileHash(repository: string, filePath: string): { hash: string; schemaVersion: string } | null;

  /**
   * #294 Phase 2a — upsert the stored content hash for a file. The
   * `schemaVersion` lets `--incremental` invalidate the cache when
   * the canonical schema changes.
   */
  setSourceFileHash(repository: string, filePath: string, hash: string, schemaVersion: string): void;

  /**
   * #294 Phase 2a — return every stored file hash for a repository.
   * Used to diff stored vs. current file lists and detect removed
   * files between incremental runs.
   */
  listSourceFileHashes(repository: string): Array<{ filePath: string; hash: string; schemaVersion: string }>;

  /**
   * #294 Phase 2a — drop the stored hash row for a file. Called when
   * the file is removed from disk so subsequent incremental runs
   * don't keep re-checking it.
   */
  deleteSourceFileHash(repository: string, filePath: string): void;

  /** Lifecycle. */
  close(): void;
}

const EDGE_ID_HASH_LENGTH = 16;

/**
 * Stable canonical-JSON serializer used to compute content-addressed
 * edge ids. Sorts object keys recursively so two semantically equal
 * edges always serialize identically.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** Compute the content-addressed id of an edge. */
function edgeId(edge: SchemaEdge): string {
  const hash = createHash('sha1').update(canonicalJson(edge)).digest('hex').slice(0, EDGE_ID_HASH_LENGTH);
  return `${edge.edgeType}:${hash}`;
}

/**
 * Map of English irregular plurals (canonical → singular) covered by
 * `generateTableNameAliases`. Used to route receiver names like
 * `personRepo` back to the canonical `people` table (and vice-versa
 * for repos that pluralise the table name to a regular form).
 */
const IRREGULAR_PLURALS: ReadonlyMap<string, string> = new Map([
  ['people', 'person'],
  ['children', 'child'],
  ['feet', 'foot'],
  ['teeth', 'tooth'],
  ['mice', 'mouse'],
  ['men', 'man'],
  ['women', 'woman'],
  ['geese', 'goose'],
  ['oxen', 'ox'],
  ['data', 'datum'],
]);

/**
 * Strip a regular English plural suffix from `s`, returning the
 * singular form or null when no rule applies. Order is significant:
 * try the more-specific patterns first (`-ies` before `-es` before
 * `-s`).
 *
 *   queries  → query        (ies → y)
 *   boxes    → box          (xes → x, sibilant before -es)
 *   classes  → class        (sses → ss)
 *   addresses → address     (sses → ss)
 *   versions → version      (-s)
 */
function regularSingular(s: string): string | null {
  // Length guard: 'is', 'as', 'bus' — too short to safely strip.
  // Real table names are nearly always >= 4 chars; this avoids
  // false-positive singulars (`is` → `i`, `bus` → `bu`).
  if (s.length < 4) return null;
  // Irregular plural wins outright.
  if (IRREGULAR_PLURALS.has(s)) return IRREGULAR_PLURALS.get(s) ?? null;
  // -ies → -y  (ties/queries/categories)
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  // -sses → -ss  (addresses → address, classes → class)
  if (s.endsWith('sses')) return s.slice(0, -2);
  // -ses → -se  (databases → database). Guard against -uses (`buses`
  // → `buse` is wrong; falls through to the trailing-s rule for
  // `bus`) and -ouses (`houses` → trailing-s gets us to `house`).
  if (s.endsWith('ses') && !s.endsWith('uses') && !s.endsWith('ouses')) {
    return s.slice(0, -1);
  }
  // -xes / -zes / -ches / -shes → strip the trailing -es
  if (s.endsWith('xes') || s.endsWith('zes') || s.endsWith('ches') || s.endsWith('shes')) {
    return s.slice(0, -2);
  }
  // Generic trailing -s.
  if (s.endsWith('s')) return s.slice(0, -1);
  return null;
}

/**
 * Generate every reasonable variant of a canonical table name that a
 * receiver-name heuristic could have produced. Used by
 * `mergeAliasedDatabaseTables` to redirect inferred tables back to
 * their canonical sibling (#384).
 *
 * For `app_versions` the set covers:
 *   - app_versions, AppVersions, appVersions
 *   - app_version, AppVersion, appVersion
 * For `users`: users / Users / user / User.
 * For `data_queries` (#399): + data_query, dataQuery, DataQuery.
 * For `addresses`: + address, Address.
 * For `people` (#399): + person, Person (via IRREGULAR_PLURALS).
 */
function generateTableNameAliases(canonical: string): string[] {
  const aliases = new Set<string>();
  const add = (s: string): void => {
    if (s) aliases.add(s);
  };
  const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const camel = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
  const snakeToCamel = (s: string): string =>
    s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

  const emit = (s: string): void => {
    add(s);
    add(pascal(s));
    add(camel(s));
    const camelForm = snakeToCamel(s);
    add(camelForm);
    add(pascal(camelForm));
    add(camel(camelForm));
  };

  emit(canonical);

  // #399 — singular form via regular suffix rules + irregular table.
  // The receiver-name heuristic emits the singular shape (`appVersion`
  // for `appVersionRepository`), so the alias set must include every
  // singular variant of the canonical's plural form.
  const singular = regularSingular(canonical);
  if (singular) emit(singular);
  return [...aliases];
}

/** SQLite implementation of `CanonicalGraphStore`. */
export class SQLiteCanonicalGraphStore implements CanonicalGraphStore {
  private db: Database.Database;
  private ownsDb: boolean;

  constructor(dbOrPath: Database.Database | string = ':memory:') {
    if (typeof dbOrPath === 'string') {
      this.db = new Database(dbOrPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    migrateCanonical(this.db);
  }

  commit(batch: NodeBatch, meta: BatchMeta): void {
    // NOTE: the design calls for a read-time check that refuses batches
    // whose `meta.schemaVersion` has an incompatible major version from
    // `SCHEMA_VERSION`. Until we reach 1.0 and can commit to a
    // compatibility contract, the gate is intentionally open on
    // commit — any `schemaVersion` is accepted and surfaced via
    // `listBatches` / `expectedSchemaVersion`. See the covering test in
    // `canonical-store.test.ts` ("schema version gate").
    // TODO(#67): turn this into an enforced check at 1.0.
    //
    // Validate everything BEFORE opening the transaction so a malformed
    // batch never produces a partial commit.
    const validatedNodes = batch.nodes.map((n) => validateNode(n));
    const validatedEdges = batch.edges.map((e) => validateEdge(e));

    const insertBatch = this.db.prepare(
      `INSERT INTO batches (schema_version, produced_by, produced_at, node_count, edge_count)
       VALUES (@schemaVersion, @producedBy, @producedAt, @nodeCount, @edgeCount)`
    );
    const upsertNode = this.db.prepare(
      `INSERT INTO canonical_nodes (id, node_type, data, batch_id, created_at, updated_at)
       VALUES (@id, @node_type, @data, @batch_id, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         node_type = excluded.node_type,
         data = excluded.data,
         batch_id = excluded.batch_id,
         updated_at = datetime('now')`
    );
    const upsertEdge = this.db.prepare(
      `INSERT INTO canonical_edges (id, edge_type, from_id, to_id, data, batch_id, created_at, updated_at)
       VALUES (@id, @edge_type, @from_id, @to_id, @data, @batch_id, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         edge_type = excluded.edge_type,
         from_id = excluded.from_id,
         to_id = excluded.to_id,
         data = excluded.data,
         batch_id = excluded.batch_id,
         updated_at = datetime('now')`
    );

    const tx = this.db.transaction(() => {
      const result = insertBatch.run({
        schemaVersion: meta.schemaVersion,
        producedBy: meta.producedBy,
        producedAt: meta.producedAt,
        nodeCount: validatedNodes.length,
        edgeCount: validatedEdges.length,
      });
      const batchId = Number(result.lastInsertRowid);

      for (const node of validatedNodes) {
        upsertNode.run({
          id: node.id,
          node_type: node.nodeType,
          data: JSON.stringify(node),
          batch_id: batchId,
        });
      }
      for (const edge of validatedEdges) {
        upsertEdge.run({
          id: edgeId(edge),
          edge_type: edge.edgeType,
          from_id: edge.from,
          to_id: edge.to,
          data: JSON.stringify(edge),
          batch_id: batchId,
        });
      }
    });
    tx();
  }

  getNode<T extends NodeType>(type: T, id: string): Extract<SchemaNode, { nodeType: T }> | null {
    const row = this.db
      .prepare('SELECT data, node_type FROM canonical_nodes WHERE id = ?')
      .get(id) as { data: string; node_type: string } | undefined;
    if (!row) return null;
    if (row.node_type !== type) return null;
    return JSON.parse(row.data) as Extract<SchemaNode, { nodeType: T }>;
  }

  getNodeById(id: string): SchemaNode | null {
    const row = this.db
      .prepare('SELECT data FROM canonical_nodes WHERE id = ?')
      .get(id) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as SchemaNode;
  }

  findNodes<T extends NodeType>(
    type: T,
    where: Partial<Extract<SchemaNode, { nodeType: T }>> = {}
  ): Extract<SchemaNode, { nodeType: T }>[] {
    const conditions: string[] = ['node_type = @type'];
    const params: Record<string, unknown> = { type };
    let i = 0;
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const param = `p${i++}`;
      // json_extract returns SQL NULL for missing fields, which never
      // equals anything via =, so explicit null comparisons need IS.
      if (value === null) {
        conditions.push(`json_extract(data, '$.${key}') IS NULL`);
      } else if (typeof value === 'boolean') {
        // better-sqlite3 cannot bind JS booleans directly, and SQLite's
        // json_extract returns booleans as integers 0/1, so we coerce.
        conditions.push(`json_extract(data, '$.${key}') = @${param}`);
        params[param] = value ? 1 : 0;
      } else if (typeof value === 'string' || typeof value === 'number') {
        conditions.push(`json_extract(data, '$.${key}') = @${param}`);
        params[param] = value;
      } else {
        // Arrays / nested objects are not supported as equality filters
        // because SQLite has no structural comparison for JSON values.
        // Callers should filter client-side for those cases.
        throw new TypeError(
          `findNodes: unsupported filter value type for field '${key}' (${typeof value}); ` +
            `only string, number, boolean, and null are supported.`
        );
      }
    }
    const sql = `SELECT data FROM canonical_nodes WHERE ${conditions.join(' AND ')}`;
    const rows = this.db.prepare(sql).all(params) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Extract<SchemaNode, { nodeType: T }>);
  }

  findEdges(from: string | null, to: string | null, type?: EdgeType): SchemaEdge[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (from !== null) {
      conditions.push('from_id = @from');
      params.from = from;
    }
    if (to !== null) {
      conditions.push('to_id = @to');
      params.to = to;
    }
    if (type !== undefined) {
      conditions.push('edge_type = @type');
      params.type = type;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT data FROM canonical_edges ${where}`).all(params) as Array<{
      data: string;
    }>;
    return rows.map((r) => JSON.parse(r.data) as SchemaEdge);
  }

  listBatches(): Array<BatchMeta & { id: number; nodeCount: number; edgeCount: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, schema_version, produced_by, produced_at, node_count, edge_count
         FROM batches ORDER BY id ASC`
      )
      .all() as Array<{
      id: number;
      schema_version: string;
      produced_by: string;
      produced_at: string;
      node_count: number;
      edge_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schemaVersion: r.schema_version,
      producedBy: r.produced_by,
      producedAt: r.produced_at,
      nodeCount: r.node_count,
      edgeCount: r.edge_count,
    }));
  }

  deleteByRepository(repository: string): { deletedNodes: number; deletedEdges: number } {
    const tx = this.db.transaction(() => {
      // Find all node IDs for this repository — both nodes with a direct
      // `repository` field and nodes with a `sourceFileId` that points to
      // a SourceFile in this repository (e.g., FunctionDefinition,
      // DatabaseInteraction).
      const directRows = this.db
        .prepare("SELECT id FROM canonical_nodes WHERE json_extract(data, '$.repository') = ?")
        .all(repository) as Array<{ id: string }>;
      const directIds = new Set(directRows.map((r) => r.id));

      // Find SourceFile IDs for this repo.
      const sourceFileIds = new Set(
        directRows
          .filter((r) => r.id.startsWith('SourceFile:'))
          .map((r) => r.id)
      );

      // Find nodes that reference these SourceFiles via sourceFileId.
      const indirectRows = sourceFileIds.size > 0
        ? [...sourceFileIds].flatMap((sfId) =>
            (this.db
              .prepare("SELECT id FROM canonical_nodes WHERE json_extract(data, '$.sourceFileId') = ?")
              .all(sfId) as Array<{ id: string }>)
          )
        : [];
      const allNodeIds = new Set([...directIds, ...indirectRows.map((r) => r.id)]);

      let deletedEdges = 0;
      const deleteEdgeStmt = this.db.prepare('DELETE FROM canonical_edges WHERE from_id = ? OR to_id = ?');
      const deleteNodeStmt = this.db.prepare('DELETE FROM canonical_nodes WHERE id = ?');

      for (const nodeId of allNodeIds) {
        deletedEdges += deleteEdgeStmt.run(nodeId, nodeId).changes;
      }
      for (const nodeId of allNodeIds) {
        deleteNodeStmt.run(nodeId);
      }

      return { deletedNodes: allNodeIds.size, deletedEdges };
    });
    return tx();
  }

  deleteByFile(repository: string, filePath: string): { deletedNodes: number; deletedEdges: number } {
    const tx = this.db.transaction(() => {
      // Find the SourceFile node for this (repository, filePath).
      const sourceFileRows = this.db
        .prepare(
          `SELECT id FROM canonical_nodes
           WHERE node_type = 'SourceFile'
             AND json_extract(data, '$.repository') = ?
             AND json_extract(data, '$.filePath') = ?`,
        )
        .all(repository, filePath) as Array<{ id: string }>;
      const sourceFileIds = new Set(sourceFileRows.map((r) => r.id));

      // Find every node whose `sourceFileId` points at this SourceFile.
      const indirectIds = new Set<string>();
      for (const sfId of sourceFileIds) {
        const rows = this.db
          .prepare(
            `SELECT id FROM canonical_nodes WHERE json_extract(data, '$.sourceFileId') = ?`,
          )
          .all(sfId) as Array<{ id: string }>;
        for (const r of rows) indirectIds.add(r.id);
      }

      // StateStore.declaredIn and DatabaseTable.declaredIn carry a
      // SourceFile id too. Without this, stale stores/tables survive
      // an incremental re-extraction of the file that declared them.
      for (const sfId of sourceFileIds) {
        const rows = this.db
          .prepare(
            `SELECT id FROM canonical_nodes WHERE json_extract(data, '$.declaredIn') = ?`,
          )
          .all(sfId) as Array<{ id: string }>;
        for (const r of rows) indirectIds.add(r.id);
      }

      // APIEndpoint nodes don't carry sourceFileId but DO carry an
      // `evidence.filePath`. Match those too so endpoint nodes are
      // dropped on incremental file removal.
      const endpointRows = this.db
        .prepare(
          `SELECT id FROM canonical_nodes
           WHERE node_type = 'APIEndpoint'
             AND json_extract(data, '$.repository') = ?
             AND json_extract(data, '$.evidence.filePath') = ?`,
        )
        .all(repository, filePath) as Array<{ id: string }>;
      for (const r of endpointRows) indirectIds.add(r.id);

      const allNodeIds = new Set<string>([...sourceFileIds, ...indirectIds]);
      if (allNodeIds.size === 0) return { deletedNodes: 0, deletedEdges: 0 };

      let deletedEdges = 0;
      const deleteEdgeStmt = this.db.prepare('DELETE FROM canonical_edges WHERE from_id = ? OR to_id = ?');
      const deleteNodeStmt = this.db.prepare('DELETE FROM canonical_nodes WHERE id = ?');
      for (const nodeId of allNodeIds) {
        deletedEdges += deleteEdgeStmt.run(nodeId, nodeId).changes;
      }
      for (const nodeId of allNodeIds) {
        deleteNodeStmt.run(nodeId);
      }
      return { deletedNodes: allNodeIds.size, deletedEdges };
    });
    return tx();
  }

  getSourceFileHash(repository: string, filePath: string): { hash: string; schemaVersion: string } | null {
    const row = this.db
      .prepare(
        `SELECT hash, schema_version FROM source_file_hashes
         WHERE repository = ? AND file_path = ?`,
      )
      .get(repository, filePath) as { hash: string; schema_version: string } | undefined;
    return row ? { hash: row.hash, schemaVersion: row.schema_version } : null;
  }

  setSourceFileHash(repository: string, filePath: string, hash: string, schemaVersion: string): void {
    this.db
      .prepare(
        `INSERT INTO source_file_hashes (repository, file_path, hash, schema_version, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(repository, file_path) DO UPDATE SET
           hash = excluded.hash,
           schema_version = excluded.schema_version,
           updated_at = datetime('now')`,
      )
      .run(repository, filePath, hash, schemaVersion);
  }

  listSourceFileHashes(repository: string): Array<{ filePath: string; hash: string; schemaVersion: string }> {
    const rows = this.db
      .prepare(
        `SELECT file_path, hash, schema_version FROM source_file_hashes WHERE repository = ?`,
      )
      .all(repository) as Array<{ file_path: string; hash: string; schema_version: string }>;
    return rows.map((r) => ({ filePath: r.file_path, hash: r.hash, schemaVersion: r.schema_version }));
  }

  deleteSourceFileHash(repository: string, filePath: string): void {
    this.db
      .prepare(`DELETE FROM source_file_hashes WHERE repository = ? AND file_path = ?`)
      .run(repository, filePath);
  }

  mergeAliasedDatabaseTables(): { mergedTables: number; rewrittenEdges: number } {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id,
                  json_extract(data, '$.name') AS name,
                  json_extract(data, '$.systemId') AS systemId,
                  json_extract(data, '$.declaredIn') AS declaredIn
           FROM canonical_nodes
           WHERE node_type = 'DatabaseTable'`,
        )
        .all() as Array<{ id: string; name: string; systemId: string; declaredIn: string | null }>;
      if (rows.length === 0) return { mergedTables: 0, rewrittenEdges: 0 };

      type SystemBuckets = {
        // alias name → canonical table id
        aliasToCanonicalId: Map<string, string>;
        inferred: Array<{ id: string; name: string }>;
        canonicalNames: Set<string>;
      };
      const bySystem = new Map<string, SystemBuckets>();
      const bucket = (sys: string): SystemBuckets => {
        let b = bySystem.get(sys);
        if (!b) {
          b = { aliasToCanonicalId: new Map(), inferred: [], canonicalNames: new Set() };
          bySystem.set(sys, b);
        }
        return b;
      };

      for (const r of rows) {
        const b = bucket(r.systemId);
        if (r.declaredIn) {
          b.canonicalNames.add(r.name);
          for (const alias of generateTableNameAliases(r.name)) {
            // First-writer-wins: never overwrite an alias mapped to
            // another canonical — keeps two legitimate canonicals
            // (e.g. `users` and `userSessions`) from cross-merging.
            if (!b.aliasToCanonicalId.has(alias)) b.aliasToCanonicalId.set(alias, r.id);
          }
        } else {
          b.inferred.push({ id: r.id, name: r.name });
        }
      }

      // We rewrite both the indexed column AND the JSON `data` column;
      // `findEdges` projects from `data` and any mismatch would surface
      // the pre-merge target. We do NOT recompute the edge content-hash
      // `id` — leaving it stable means downstream re-runs that produce
      // the same edge content will UPSERT against the same row instead
      // of creating an orphan duplicate.
      const updateEdgeTo = this.db.prepare(
        `UPDATE OR REPLACE canonical_edges
         SET to_id = @new, data = json_set(data, '$.to', @new)
         WHERE to_id = @old`,
      );
      const updateEdgeFrom = this.db.prepare(
        `UPDATE OR REPLACE canonical_edges
         SET from_id = @new, data = json_set(data, '$.from', @new)
         WHERE from_id = @old`,
      );
      const deleteNode = this.db.prepare(`DELETE FROM canonical_nodes WHERE id = ?`);

      let mergedTables = 0;
      let rewrittenEdges = 0;
      for (const b of bySystem.values()) {
        for (const inf of b.inferred) {
          // Never merge an inferred name that collides with an existing
          // canonical name — that would change semantics.
          if (b.canonicalNames.has(inf.name)) continue;
          const canonicalId = b.aliasToCanonicalId.get(inf.name);
          if (!canonicalId || canonicalId === inf.id) continue;

          rewrittenEdges += updateEdgeTo.run({ new: canonicalId, old: inf.id }).changes;
          rewrittenEdges += updateEdgeFrom.run({ new: canonicalId, old: inf.id }).changes;
          deleteNode.run(inf.id);
          mergedTables += 1;
        }
      }
      return { mergedTables, rewrittenEdges };
    });
    return tx();
  }

  pruneEmptyDatabaseSystems(): { deletedSystems: number; deletedEdges: number } {
    const tx = this.db.transaction(() => {
      const systemRows = this.db
        .prepare("SELECT id FROM canonical_nodes WHERE node_type = 'DatabaseSystem'")
        .all() as Array<{ id: string }>;
      if (systemRows.length === 0) return { deletedSystems: 0, deletedEdges: 0 };

      const tableHasSystemStmt = this.db.prepare(
        "SELECT 1 FROM canonical_nodes WHERE node_type = 'DatabaseTable' AND json_extract(data, '$.systemId') = ? LIMIT 1",
      );
      const deleteEdgeStmt = this.db.prepare('DELETE FROM canonical_edges WHERE from_id = ? OR to_id = ?');
      const deleteNodeStmt = this.db.prepare('DELETE FROM canonical_nodes WHERE id = ?');

      let deletedSystems = 0;
      let deletedEdges = 0;
      for (const { id } of systemRows) {
        const hasTable = tableHasSystemStmt.get(id);
        if (hasTable) continue;
        deletedEdges += deleteEdgeStmt.run(id, id).changes;
        deleteNodeStmt.run(id);
        deletedSystems += 1;
      }
      return { deletedSystems, deletedEdges };
    });
    return tx();
  }

  listRepositories(): Array<{
    repository: string;
    sourceFiles: number;
    endpoints: number;
    clientApiCalls: number;
    clientProcesses: number;
  }> {
    const rows = this.db.prepare(`
      SELECT
        json_extract(data, '$.repository') AS repository,
        SUM(CASE WHEN node_type = 'SourceFile' THEN 1 ELSE 0 END) AS source_files,
        SUM(CASE WHEN node_type = 'APIEndpoint' THEN 1 ELSE 0 END) AS endpoints,
        SUM(CASE WHEN node_type = 'ClientSideAPICaller' THEN 1 ELSE 0 END) AS client_api_calls,
        SUM(CASE WHEN node_type = 'ClientSideProcess' THEN 1 ELSE 0 END) AS client_processes
      FROM canonical_nodes
      WHERE json_extract(data, '$.repository') IS NOT NULL
      GROUP BY json_extract(data, '$.repository')
      ORDER BY source_files DESC
    `).all() as Array<{
      repository: string;
      source_files: number;
      endpoints: number;
      client_api_calls: number;
      client_processes: number;
    }>;

    return rows.map((r) => ({
      repository: r.repository,
      sourceFiles: r.source_files,
      endpoints: r.endpoints,
      clientApiCalls: r.client_api_calls,
      clientProcesses: r.client_processes,
    }));
  }

  /** Expose the current schema version constant for read-time checks. */
  get expectedSchemaVersion(): string {
    return SCHEMA_VERSION;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO project_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM project_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  close(): void {
    if (this.ownsDb) {
      // Checkpoint and truncate the WAL so companion files (-wal, -shm)
      // are cleaned up. Without this, stale WAL files left after the
      // process exits can cause "disk I/O error" if the main .db file
      // is deleted without also deleting the WAL/SHM files.
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore if not in WAL mode */ }
      this.db.close();
    }
  }
}
