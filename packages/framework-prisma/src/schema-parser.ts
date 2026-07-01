import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSchema } from '@mrleebo/prisma-ast';
import {
  idFor,
  type DatabaseColumn,
  type DatabaseKind,
  type DatabaseSystem,
  type DatabaseTable,
  type DatabaseTableKind,
  type SchemaEdge,
  type SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';

/**
 * Schema-level extraction for Prisma.
 *
 * Walks a project root looking for `schema.prisma` files, parses them
 * via `@mrleebo/prisma-ast`, and emits the canonical data-model nodes
 * and edges from `@veoable/schema` + `@veoable/framework-prisma`:
 *
 *   - `DatabaseSystem` — one per `datasource` block
 *   - `DatabaseTable`  — one per `model` block
 *   - `DatabaseColumn` — one per field inside a `model`
 *   - `TABLE_IN`       — every `DatabaseTable` → its `DatabaseSystem`
 *   - `COLUMN_IN`      — every `DatabaseColumn` → its `DatabaseTable`
 *   - `FOREIGN_KEY`    — every `@relation(fields, references)` pair
 *
 * Call-site detection (`DatabaseInteraction` + `READS`/`WRITES` +
 * `PERFORMED_BY`) is deferred to PR 2 of #47 — that work lives in the
 * Prisma visitor, not here.
 */

export interface ExtractSchemasOptions {
  /** Absolute path to the project root. */
  rootDir: string;
  /** Whether to recurse into subdirectories beyond the standard `prisma/` dir. Default: true. */
  recursive?: boolean;
}

/**
 * Find every CANONICAL Prisma schema under `rootDir` — i.e., files
 * matching the same rule as `findPrismaSchemaUnder` in
 * `prisma-plugin.ts`:
 *
 *   (a) a file named `schema.prisma`, OR
 *   (b) any `*.prisma` file inside a `prisma/` directory.
 *
 * Bounded recursion depth so a workspace-wide scan stays cheap on
 * monorepos. Used by the CLI orchestrator (#344) to pre-discover
 * schemas once per `project analyze` invocation instead of letting
 * every per-repo `PrismaPlugin` instance re-walk the same tree.
 *
 * Returns absolute paths in deterministic (sorted) order. Skips
 * `node_modules`, build artefacts, and dotfiles. Returns an empty
 * array on read errors so callers can treat "no schemas" uniformly.
 *
 * ## Depth bound
 *
 * `maxDepth` defaults to 5. This covers the conventional
 * `<workspaceRoot>/<package>/prisma/schema.prisma` layout (depth 3)
 * and the deeper `<workspaceRoot>/apps/<app>/packages/<pkg>/prisma/schema.prisma`
 * (depth 5). A schema buried 6+ levels below `rootDir` is silently
 * skipped — this trades worst-case scan time on huge monorepos
 * against the unlikely deeply-nested layout. Workarounds for
 * deeper layouts:
 *   - Run `project analyze` from a closer workspace root (e.g.,
 *     point the project config at the sub-monorepo containing the
 *     schema).
 *   - Pass an explicit larger `maxDepth` when calling this helper
 *     directly.
 *   - Restructure the layout so the schema is at depth ≤ 5.
 *
 * The CLI's `project analyze` logs the depth bound in verbose mode
 * so users can see why a deep schema wasn't picked up.
 */
export function findCanonicalPrismaSchemas(rootDir: string, maxDepth = 5): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number, inPrismaDir: boolean): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.prisma')) {
        // Canonical: `schema.prisma` OR any `.prisma` inside a `prisma/` dir.
        if (e.name === 'schema.prisma' || inPrismaDir) results.push(full);
        continue;
      }
      if (e.isDirectory()) {
        walk(full, depth + 1, inPrismaDir || e.name === 'prisma');
      }
    }
  };
  walk(rootDir, 0, false);
  return results.sort();
}

/**
 * Find every `*.prisma` file under `rootDir`, excluding `node_modules`
 * and hidden (`.`-prefixed) directories.
 *
 * When `recursive` is `false`, only files directly inside `rootDir`
 * and inside `rootDir/prisma/` are returned — that covers the two
 * conventional Prisma layouts (`./schema.prisma` and
 * `./prisma/schema.prisma`) without walking arbitrary nested trees.
 * When `recursive` is `true` (the default), the full tree is walked.
 */
export function findSchemaFiles(rootDir: string, recursive = true): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (recursive) {
          walk(full, depth + 1);
        } else if (depth === 0 && entry.name === 'prisma') {
          // In non-recursive mode we still descend into the canonical
          // `prisma/` subdirectory so callers can discover
          // `./prisma/schema.prisma` without asking for full recursion.
          walk(full, depth + 1);
        }
      } else if (entry.isFile() && entry.name.endsWith('.prisma')) {
        results.push(full);
      }
    }
  };
  walk(rootDir, 0);
  return results.sort();
}

/**
 * Parse every `*.prisma` file under the given root and emit the
 * canonical database schema nodes/edges. Returns an aggregated
 * `NodeBatch` with deduplicated content-addressed node ids — if two
 * schema files declare the same `model User`, they collide into a
 * single `DatabaseTable` by design (the canonical store would
 * idempotently upsert them anyway; this just keeps the batch tidy).
 */
export function extractPrismaSchemas(opts: ExtractSchemasOptions): NodeBatch {
  const { rootDir, recursive = true } = opts;
  const files = findSchemaFiles(rootDir, recursive);

  // #346 — The parent-walk fallback that used to live here is now
  // redundant. Cross-package activation (#334) is handled by
  // `PrismaPlugin.appliesTo`/`onProjectLoaded` consulting
  // `ctx.workspaceRoot` and the orchestrator-supplied
  // `ctx.prismaSchemas` list (#344). Callers reaching this function
  // directly are expected to pass a `rootDir` that actually contains
  // the schema (test fixtures, single-repo CLI runs, or sub-repos
  // whose plugin already narrowed the path).
  if (files.length === 0) return { nodes: [], edges: [] };

  const nodes = new Map<string, SchemaNode>();
  const edges: SchemaEdge[] = [];
  const seenEdges = new Set<string>();
  const pushNode = (n: SchemaNode): void => {
    // Keep the first emission per id; later duplicates are ignored
    // because the content-addressed id guarantees they're identical.
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const pushEdge = (e: SchemaEdge): void => {
    // Edges are not content-addressed in `@veoable/schema`; dedupe
    // on `(edgeType, from, to)` for structural edges because we expect
    // at most one of each per pair. Relation attributes may declare
    // multi-column foreign keys — each column pair gets its own edge.
    const key = `${e.edgeType}|${e.from}|${e.to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(e);
  };

  // #325 — Two-pass extraction so the `prismaSchemaFolder` preview
  // (and any layout where the datasource lives in a different file
  // from its models) works. Prior single-pass behavior parsed each
  // file in isolation and silently dropped model files that had no
  // local datasource — exactly the dub/`packages/prisma/schema/`
  // pattern with 30+ model shards alongside a single
  // `schema.prisma` carrying the datasource.
  //
  // Pass 1: read every file once, locate the FIRST datasource across
  //         all files (Prisma supports only one), and collect all
  //         model names so navigation-property detection works
  //         cross-file (e.g., a model in `user.prisma` referencing
  //         a model in `post.prisma`).
  // Pass 2: extract models from every file, attributing each to the
  //         project-wide datasource discovered in pass 1.
  const parsed = files.map((filePath) => ({
    filePath,
    schema: getSchema(fs.readFileSync(filePath, 'utf8')),
  }));

  let firstSystem: DatabaseSystem | undefined;
  for (const { schema } of parsed) {
    const ds = extractDatasource(schema);
    if (ds) { firstSystem = ds; break; }
  }

  if (!firstSystem) return { nodes: [], edges: [] };
  pushNode(firstSystem);

  const modelNames = new Set<string>();
  for (const { schema } of parsed) {
    for (const block of schema.list) {
      if (block.type === 'model' && typeof (block as { name?: string }).name === 'string') {
        modelNames.add((block as { name: string }).name);
      }
    }
  }

  for (const { filePath, schema } of parsed) {
    extractModels(filePath, schema, firstSystem, modelNames, pushNode, pushEdge);
  }

  return { nodes: Array.from(nodes.values()), edges };
}

/**
 * Pass 1 helper — find the first `datasource` block in a parsed schema
 * and produce a `DatabaseSystem` node. Returns undefined when the file
 * has none (e.g., a model-only shard in a `prismaSchemaFolder` layout).
 *
 * Prisma supports a single datasource per project; the first one wins
 * across files (#325) so model-only shards still attribute to it.
 */
function extractDatasource(
  schema: ReturnType<typeof getSchema>,
): DatabaseSystem | undefined {
  for (const block of schema.list) {
    if (block.type !== 'datasource') continue;
    const name = block.name;
    const assignments = (block as { assignments?: unknown[] }).assignments ?? [];
    let provider: string | undefined;
    let url: string | undefined;
    for (const a of assignments) {
      const assignment = a as { type?: string; key?: string; value?: unknown };
      if (assignment.type !== 'assignment' || typeof assignment.key !== 'string') continue;
      if (assignment.key === 'provider') {
        provider = parseStringValue(assignment.value);
      } else if (assignment.key === 'url') {
        url = stringifyValue(assignment.value);
      }
    }
    const kind = normalizeProvider(provider);
    return {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind, name }),
      kind,
      name,
      connectionSource: url ?? null,
    };
  }
  return undefined;
}

/**
 * Pass 2 helper — extract `model` blocks from a single parsed schema
 * file, attributing each table to the workspace-wide `firstSystem`
 * located in pass 1. `modelNames` is the union of model names across
 * ALL files so navigation-property detection works for relations
 * that cross shard boundaries.
 */
function extractModels(
  filePath: string,
  schema: ReturnType<typeof getSchema>,
  firstSystem: DatabaseSystem,
  modelNames: Set<string>,
  pushNode: (n: SchemaNode) => void,
  pushEdge: (e: SchemaEdge) => void,
): void {
  for (const block of schema.list) {
    if (block.type !== 'model') continue;
    const modelName = (block as { name: string }).name;

    const tableKind: DatabaseTableKind =
      firstSystem.kind === 'mongodb' ? 'collection' : 'table';

    const table: DatabaseTable = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: firstSystem.id, schema: null, name: modelName }),
      systemId: firstSystem.id,
      name: modelName,
      schema: null,
      kind: tableKind,
      declaredIn: filePath,
    };
    pushNode(table);
    pushEdge({ edgeType: 'TABLE_IN', from: table.id, to: firstSystem.id });

    // Collect field-name → column-id so FOREIGN_KEY edges can reference
    // the declared fields on this model.
    const columnsByFieldName = new Map<string, DatabaseColumn>();
    const properties = (block as { properties?: unknown[] }).properties ?? [];
    for (const p of properties) {
      const prop = p as {
        type?: string;
        name?: string;
        fieldType?: string;
        array?: boolean;
        optional?: boolean;
        attributes?: unknown[];
      };
      if (prop.type !== 'field' || typeof prop.name !== 'string') continue;

      const attributes = prop.attributes ?? [];
      const isPrimaryKey = attributes.some(
        (a) => (a as { name?: string }).name === 'id'
      );
      const relationAttr = attributes.find(
        (a) => (a as { name?: string }).name === 'relation'
      ) as { args?: unknown[] } | undefined;
      // A field is a relation/navigation field if either:
      //   (a) it has an `@relation` attribute (the side holding the FK), or
      //   (b) its fieldType is a declared model name (the other side —
      //       typically an array navigation like `posts Post[]` that
      //       Prisma does not require `@relation` on).
      const fieldTypeIsModel =
        typeof prop.fieldType === 'string' && modelNames.has(prop.fieldType);
      const isRelationField = relationAttr !== undefined || fieldTypeIsModel;

      // Only scalar fields become DatabaseColumn nodes. Relation
      // fields (`author User @relation(...)`) are *navigational*
      // properties on the Prisma side — the actual FK column is the
      // `authorId Int` scalar alongside them. We still iterate them
      // so we can record the FOREIGN_KEY edge from the scalar FK
      // column to the remote column, but we don't emit a
      // `DatabaseColumn` for the navigation property itself.
      if (isRelationField) {
        // The relation attribute tells us which scalar fields on THIS
        // model hold the foreign keys, and which fields on the target
        // model they reference.
        const relationInfo = parseRelationAttribute(relationAttr);
        if (relationInfo && typeof prop.fieldType === 'string') {
          const targetTableId = idFor.databaseTable({
            systemId: firstSystem.id,
            schema: null,
            name: prop.fieldType,
          });
          for (let i = 0; i < relationInfo.fields.length; i++) {
            const localFieldName = relationInfo.fields[i];
            const remoteFieldName = relationInfo.references[i];
            if (!localFieldName || !remoteFieldName) continue;
            const localColumnId = idFor.databaseColumn({
              tableId: table.id,
              name: localFieldName,
            });
            const remoteColumnId = idFor.databaseColumn({
              tableId: targetTableId,
              name: remoteFieldName,
            });
            pushEdge({
              edgeType: 'FOREIGN_KEY',
              from: localColumnId,
              to: remoteColumnId,
              onDelete: relationInfo.onDelete ?? null,
              onUpdate: relationInfo.onUpdate ?? null,
            });
          }
        }
        continue;
      }

      const column: DatabaseColumn = {
        nodeType: 'DatabaseColumn',
        id: idFor.databaseColumn({ tableId: table.id, name: prop.name }),
        tableId: table.id,
        name: prop.name,
        type: prop.fieldType ?? null,
        nullable: prop.optional ?? false,
        isPrimaryKey,
        isForeignKey: false, // Patched below once we've seen the relation fields.
      };
      pushNode(column);
      pushEdge({ edgeType: 'COLUMN_IN', from: column.id, to: table.id });
      columnsByFieldName.set(prop.name, column);
    }

    // Second pass over the same model to mark `isForeignKey: true` on
    // any scalar column that's mentioned in a relation's `fields`
    // list. We can't do this in a single pass because the relation
    // attribute on the navigation property references scalar columns
    // that may be declared in any order relative to it.
    for (const p of properties) {
      const prop = p as { type?: string; attributes?: unknown[] };
      if (prop.type !== 'field') continue;
      const relationAttr = (prop.attributes ?? []).find(
        (a) => (a as { name?: string }).name === 'relation'
      ) as { args?: unknown[] } | undefined;
      if (!relationAttr) continue;
      const relationInfo = parseRelationAttribute(relationAttr);
      if (!relationInfo) continue;
      for (const fkFieldName of relationInfo.fields) {
        const column = columnsByFieldName.get(fkFieldName);
        if (column) {
          column.isForeignKey = true;
        }
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Small helpers
// ──────────────────────────────────────────────────────────────────────

function parseStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // The parser keeps the surrounding quotes in string literals.
  return value.replace(/^"|"$/g, '');
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'type' in (value as object)) {
    const v = value as { type?: string; name?: string; params?: unknown[] };
    if (v.type === 'function') {
      const params = (v.params ?? []).map((p) => String(p)).join(', ');
      return `${v.name}(${params})`;
    }
  }
  return String(value ?? '');
}

function normalizeProvider(provider: string | undefined): DatabaseKind {
  const normalized = (provider ?? 'other').toLowerCase();
  switch (normalized) {
    case 'postgresql':
    case 'postgres':
      return 'postgres';
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'sqlserver':
    case 'mssql':
      return 'mssql';
    case 'mongodb':
      return 'mongodb';
    case 'cockroachdb':
      return 'postgres'; // Cockroach speaks Postgres wire protocol.
    default:
      return 'other';
  }
}

interface RelationInfo {
  fields: string[];
  references: string[];
  onDelete?: string;
  onUpdate?: string;
}

/**
 * Parse a `@relation(fields: [a, b], references: [c, d])` attribute's
 * args list out of the prisma-ast AST shape. Returns `null` if the
 * attribute doesn't contain the minimum `fields` + `references`
 * arrays we need to emit a FOREIGN_KEY edge.
 */
function parseRelationAttribute(attr: { args?: unknown[] } | undefined): RelationInfo | null {
  if (!attr || !Array.isArray(attr.args)) return null;
  let fields: string[] | undefined;
  let references: string[] | undefined;
  let onDelete: string | undefined;
  let onUpdate: string | undefined;
  for (const arg of attr.args) {
    const a = arg as { type?: string; value?: unknown };
    if (a.type !== 'attributeArgument') continue;
    const value = a.value as { type?: string; key?: string; value?: unknown } | string | undefined;
    if (!value || typeof value !== 'object' || value.type !== 'keyValue') continue;
    if (value.key === 'fields') fields = parseArrayValue(value.value);
    else if (value.key === 'references') references = parseArrayValue(value.value);
    else if (value.key === 'onDelete') onDelete = typeof value.value === 'string' ? value.value : undefined;
    else if (value.key === 'onUpdate') onUpdate = typeof value.value === 'string' ? value.value : undefined;
  }
  if (!fields || !references || fields.length === 0 || references.length === 0) return null;
  return { fields, references, onDelete, onUpdate };
}

function parseArrayValue(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { type?: string; args?: unknown[] };
  if (v.type !== 'array' || !Array.isArray(v.args)) return undefined;
  return v.args.map((a) => String(a));
}
