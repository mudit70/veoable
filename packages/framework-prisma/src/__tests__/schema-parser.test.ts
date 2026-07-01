import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  idFor,
  validateEdge,
  validateNode,
  type DatabaseTable,
  type ForeignKeyEdge,
  type SchemaEdge,
  type SchemaNode,
} from '@veoable/schema';
import { makeBatchMeta } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import {
  PrismaPlugin,
  extractPrismaSchemas,
  findCanonicalPrismaSchemas,
  findSchemaFiles,
} from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/prisma');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

function nodesByType<T extends SchemaNode['nodeType']>(
  batch: { nodes: SchemaNode[] },
  type: T
): Extract<SchemaNode, { nodeType: T }>[] {
  return batch.nodes.filter((n): n is Extract<SchemaNode, { nodeType: T }> => n.nodeType === type);
}

function edgesByType<T extends SchemaEdge['edgeType']>(
  batch: { edges: SchemaEdge[] },
  type: T
): Extract<SchemaEdge, { edgeType: T }>[] {
  return batch.edges.filter((e): e is Extract<SchemaEdge, { edgeType: T }> => e.edgeType === type);
}

// ──────────────────────────────────────────────────────────────────────
// Schema discovery
// ──────────────────────────────────────────────────────────────────────

describe('findSchemaFiles', () => {
  it('finds prisma/schema.prisma under a Prisma project root', () => {
    const files = findSchemaFiles(fixturePath('postgres-basic'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/prisma[/\\]schema\.prisma$/);
  });

  it('skips node_modules and hidden directories', () => {
    const files = findSchemaFiles(fixturePath('postgres-basic'));
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('returns an empty list for a project with no prisma files', () => {
    // The tests/ dir itself has none.
    const files = findSchemaFiles(path.resolve(__dirname, '..'));
    expect(files).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Postgres basic schema
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — postgres-basic fixture', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('postgres-basic') });

  it('every emitted node and edge passes canonical validation', () => {
    for (const node of batch.nodes) expect(() => validateNode(node)).not.toThrow();
    for (const edge of batch.edges) expect(() => validateEdge(edge)).not.toThrow();
  });

  it('emits a DatabaseSystem with kind="postgres" and the env() url captured', () => {
    const systems = nodesByType(batch, 'DatabaseSystem');
    expect(systems).toHaveLength(1);
    expect(systems[0].kind).toBe('postgres');
    expect(systems[0].name).toBe('db');
    expect(systems[0].connectionSource).toBe('env("DATABASE_URL")');
  });

  it('emits one DatabaseTable per model with kind="table"', () => {
    const tables = nodesByType(batch, 'DatabaseTable');
    expect(tables.map((t) => t.name).sort()).toEqual(['Post', 'User']);
    for (const t of tables) expect(t.kind).toBe('table');
  });

  it('tables are linked to the system via TABLE_IN edges', () => {
    const system = nodesByType(batch, 'DatabaseSystem')[0];
    const tables = nodesByType(batch, 'DatabaseTable');
    const tableIn = edgesByType(batch, 'TABLE_IN');
    expect(tableIn).toHaveLength(tables.length);
    for (const t of tables) {
      expect(tableIn.some((e) => e.from === t.id && e.to === system.id)).toBe(true);
    }
  });

  it('emits a DatabaseColumn for every scalar field (but NOT for navigation properties)', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const names = columns.map((c) => c.name).sort();
    // User: id, email, name, createdAt (no `posts` — that's a navigation property)
    // Post: id, title, content, authorId (no `author` — navigation property)
    expect(names).toEqual(['authorId', 'content', 'createdAt', 'email', 'id', 'id', 'name', 'title']);
  });

  it('columns are linked to their tables via COLUMN_IN', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const columnIn = edgesByType(batch, 'COLUMN_IN');
    expect(columnIn).toHaveLength(columns.length);
    for (const c of columns) {
      expect(columnIn.some((e) => e.from === c.id && e.to === c.tableId)).toBe(true);
    }
  });

  it('marks @id fields as isPrimaryKey', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const primaryKeys = columns.filter((c) => c.isPrimaryKey);
    // One `id` per model.
    expect(primaryKeys).toHaveLength(2);
    expect(primaryKeys.every((c) => c.name === 'id')).toBe(true);
  });

  it('marks optional fields as nullable', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const nullable = columns.filter((c) => c.nullable);
    expect(nullable.map((c) => c.name).sort()).toEqual(['content', 'name']);
  });

  it('captures Prisma scalar types on columns', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const byName = new Map(columns.map((c) => [`${c.tableId}|${c.name}`, c]));
    // Find the `createdAt` column and assert it has type 'DateTime'.
    const created = columns.find((c) => c.name === 'createdAt');
    expect(created?.type).toBe('DateTime');
    // `email` is String.
    const email = columns.find((c) => c.name === 'email');
    expect(email?.type).toBe('String');
    void byName;
  });

  it('emits a FOREIGN_KEY edge from Post.authorId to User.id', () => {
    const fks = edgesByType(batch, 'FOREIGN_KEY');
    expect(fks).toHaveLength(1);
    const fk = fks[0];

    const postTableId = idFor.databaseTable({
      systemId: idFor.databaseSystem({ kind: 'postgres', name: 'db' }),
      schema: null,
      name: 'Post',
    });
    const userTableId = idFor.databaseTable({
      systemId: idFor.databaseSystem({ kind: 'postgres', name: 'db' }),
      schema: null,
      name: 'User',
    });
    const authorIdColumnId = idFor.databaseColumn({ tableId: postTableId, name: 'authorId' });
    const userIdColumnId = idFor.databaseColumn({ tableId: userTableId, name: 'id' });

    expect(fk.from).toBe(authorIdColumnId);
    expect(fk.to).toBe(userIdColumnId);
    expect(fk.onDelete).toBe('Cascade');
  });

  it('marks the FK scalar column as isForeignKey: true', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const authorId = columns.find((c) => c.name === 'authorId');
    expect(authorId).toBeDefined();
    expect(authorId!.isForeignKey).toBe(true);
    // Non-FK scalars stay false.
    const title = columns.find((c) => c.name === 'title');
    expect(title?.isForeignKey).toBe(false);
  });

  it('records the schema file path in declaredIn', () => {
    const tables = nodesByType(batch, 'DatabaseTable');
    for (const t of tables) {
      expect(t.declaredIn).toMatch(/schema\.prisma$/);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// MongoDB schema
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — mongodb-basic fixture', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('mongodb-basic') });

  it('emits a DatabaseSystem with kind="mongodb"', () => {
    const systems = nodesByType(batch, 'DatabaseSystem');
    expect(systems).toHaveLength(1);
    expect(systems[0].kind).toBe('mongodb');
  });

  it('emits tables with kind="collection" for MongoDB', () => {
    const tables = nodesByType(batch, 'DatabaseTable');
    expect(tables).toHaveLength(1);
    expect(tables[0].kind).toBe('collection');
    expect(tables[0].name).toBe('Account');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-relation schema
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — with-relations fixture', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('with-relations') });

  it('emits a FOREIGN_KEY edge for every @relation(fields, references) pair', () => {
    const fks = edgesByType(batch, 'FOREIGN_KEY');
    // Order.customerId → Customer.id
    // OrderItem.orderId → Order.id
    // OrderItem.productSku → Product.sku
    expect(fks).toHaveLength(3);
  });

  it('captures onDelete from relation attributes that specify it', () => {
    const fks = edgesByType(batch, 'FOREIGN_KEY');
    const cascades = fks.filter((f) => f.onDelete === 'Cascade');
    expect(cascades).toHaveLength(1); // OrderItem.orderId → Order.id
  });

  it('marks all FK columns as isForeignKey: true', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const fkColumns = columns.filter((c) => c.isForeignKey).map((c) => c.name).sort();
    expect(fkColumns).toEqual(['customerId', 'orderId', 'productSku']);
  });

  it('uses a non-integer primary key (Product.sku: String @id)', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const sku = columns.find((c) => c.name === 'sku');
    expect(sku).toBeDefined();
    expect(sku!.isPrimaryKey).toBe(true);
    expect(sku!.type).toBe('String');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Empty / missing schema
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — no schema files', () => {
  it('returns an empty batch for a project with no .prisma files', () => {
    // Use the test dir itself — no schema.prisma there.
    const batch = extractPrismaSchemas({ rootDir: path.resolve(__dirname, '..') });
    expect(batch.nodes).toEqual([]);
    expect(batch.edges).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// PrismaPlugin
// ──────────────────────────────────────────────────────────────────────

describe('PrismaPlugin', () => {
  it('has id="prisma" and language="ts"', () => {
    const plugin = new PrismaPlugin();
    expect(plugin.id).toBe('prisma');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when @prisma/client is a dependency', () => {
    const plugin = new PrismaPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { '@prisma/client': '^5.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true when `prisma` is in devDependencies', () => {
    const plugin = new PrismaPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { devDependencies: { prisma: '^5.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true when a prisma/schema.prisma file exists even without package.json', () => {
    const plugin = new PrismaPlugin();
    expect(
      plugin.appliesTo({ rootDir: fixturePath('postgres-basic'), packageJson: null, files: [] })
    ).toBe(true);
  });

  it('appliesTo returns false for a project with no Prisma signal', () => {
    const plugin = new PrismaPlugin();
    expect(
      plugin.appliesTo({
        rootDir: path.resolve(__dirname, '..'),
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: ['src/app.ts'],
      })
    ).toBe(false);
  });

  it('extractSchemas returns the same batch extractPrismaSchemas would', () => {
    const plugin = new PrismaPlugin();
    const direct = extractPrismaSchemas({ rootDir: fixturePath('postgres-basic') });
    const viaPlugin = plugin.extractSchemas(fixturePath('postgres-basic'));
    expect(viaPlugin.nodes).toEqual(direct.nodes);
    expect(viaPlugin.edges).toEqual(direct.edges);
  });

  it('visitor is a no-op stub in PR 1', () => {
    const plugin = new PrismaPlugin();
    expect(plugin.visitor.language).toBe('ts');
    // Calling it must not throw.
    expect(() => plugin.visitor.onNode()).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Canonical validation for every shipping fixture
// ──────────────────────────────────────────────────────────────────────

describe('canonical validation across all fixtures', () => {
  const scenarios = [
    'mongodb-basic',
    'with-relations',
    'self-ref',
    'many-to-many',
    'composite-attrs',
    'multi-schema',
    'multi-datasource',
    'fk-before-scalar',
    'plain-url',
  ];
  for (const scenario of scenarios) {
    it(`${scenario}: every emitted node and edge passes validateNode/validateEdge`, () => {
      const batch = extractPrismaSchemas({ rootDir: fixturePath(scenario) });
      for (const node of batch.nodes) expect(() => validateNode(node)).not.toThrow();
      for (const edge of batch.edges) expect(() => validateEdge(edge)).not.toThrow();
    });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Self-referential relation: navigation-field detection must use the
// "fieldType matches a declared model name" rule, not just @relation.
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — self-ref fixture', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('self-ref') });

  it('does not emit DatabaseColumn nodes for self-referential navigation fields', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const names = columns.map((c) => c.name).sort();
    // TreeNode: id, label, parentId. NOT parent, NOT children.
    expect(names).toEqual(['id', 'label', 'parentId']);
  });

  it('marks parentId as isForeignKey: true via the self-referential relation', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const parentId = columns.find((c) => c.name === 'parentId');
    expect(parentId?.isForeignKey).toBe(true);
  });

  it('emits a FOREIGN_KEY edge from parentId back to TreeNode.id', () => {
    const fks = edgesByType(batch, 'FOREIGN_KEY');
    expect(fks).toHaveLength(1);
    expect(fks[0].from).not.toBe(fks[0].to);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Implicit many-to-many: no @relation, no explicit FK scalar. Both
// navigation fields must still be excluded from DatabaseColumn emission.
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — many-to-many fixture', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('many-to-many') });

  it('excludes implicit m2m navigation fields (tags, posts) from DatabaseColumns', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const names = columns.map((c) => c.name).sort();
    // Post: id, title. Tag: id, name. NOT tags, NOT posts.
    expect(names).toEqual(['id', 'id', 'name', 'title']);
  });

  it('emits no FOREIGN_KEY edges for an implicit m2m (Prisma manages the join table)', () => {
    const fks = edgesByType(batch, 'FOREIGN_KEY');
    expect(fks).toEqual([]);
  });

  it('still emits both DatabaseTables for the m2m endpoints', () => {
    const tables = nodesByType(batch, 'DatabaseTable');
    expect(tables.map((t) => t.name).sort()).toEqual(['Post', 'Tag']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Composite @@id / @@unique / @@index — must not crash. Known gap:
// composite PKs do not currently flip isPrimaryKey on member columns.
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — composite-attrs fixture', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('composite-attrs') });

  it('parses composite @@id/@@unique/@@index models without throwing', () => {
    const tables = nodesByType(batch, 'DatabaseTable');
    expect(tables.map((t) => t.name).sort()).toEqual(['Membership', 'Pivot']);
  });

  it('known gap: composite @@id does NOT flip isPrimaryKey on member columns', () => {
    // Pinned as current behavior so a future PR that fixes this has to
    // deliberately update this test instead of accidentally regressing.
    const columns = nodesByType(batch, 'DatabaseColumn');
    const pks = columns.filter((c) => c.isPrimaryKey);
    expect(pks).toEqual([]);
  });

  it('emits a DatabaseTable for Pivot even though it has only composite-key scalar columns', () => {
    const tables = nodesByType(batch, 'DatabaseTable');
    const pivot = tables.find((t) => t.name === 'Pivot');
    expect(pivot).toBeDefined();
    const pivotColumns = nodesByType(batch, 'DatabaseColumn').filter(
      (c) => c.tableId === pivot!.id
    );
    expect(pivotColumns.map((c) => c.name).sort()).toEqual(['leftId', 'rightId']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-file schema: two .prisma files under one project root.
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — multi-schema fixture', () => {
  const root = fixturePath('multi-schema');

  it('finds both .prisma files', () => {
    const files = findSchemaFiles(root);
    expect(files).toHaveLength(2);
    expect(files.map((f) => path.basename(f)).sort()).toEqual([
      'datasource.prisma',
      'models.prisma',
    ]);
  });

  it('merges models from both files into one batch, deduping the shared system', () => {
    const batch = extractPrismaSchemas({ rootDir: root });
    const systems = nodesByType(batch, 'DatabaseSystem');
    // Both files declare `datasource db { postgres }` — content-addressed
    // ids collide so we keep exactly one DatabaseSystem node.
    expect(systems).toHaveLength(1);
    const tables = nodesByType(batch, 'DatabaseTable');
    expect(tables.map((t) => t.name).sort()).toEqual(['Account', 'Session']);
  });

  it('attributes both tables to the same shared DatabaseSystem', () => {
    const batch = extractPrismaSchemas({ rootDir: root });
    const system = nodesByType(batch, 'DatabaseSystem')[0];
    const tables = nodesByType(batch, 'DatabaseTable');
    for (const t of tables) expect(t.systemId).toBe(system.id);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-datasource: first in source order wins, rest are silently ignored.
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — multi-datasource fixture', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('multi-datasource') });

  it('emits exactly one DatabaseSystem, picking the first datasource block', () => {
    const systems = nodesByType(batch, 'DatabaseSystem');
    expect(systems).toHaveLength(1);
    expect(systems[0].name).toBe('primary');
    expect(systems[0].kind).toBe('postgres');
  });

  it('attributes models to the first (winning) datasource', () => {
    const system = nodesByType(batch, 'DatabaseSystem')[0];
    const tables = nodesByType(batch, 'DatabaseTable');
    expect(tables).toHaveLength(1);
    expect(tables[0].systemId).toBe(system.id);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Relation field declared BEFORE its scalar FK column. The two-pass
// patching must still set isForeignKey: true on the scalar.
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — fk-before-scalar fixture', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('fk-before-scalar') });

  it('marks authorId as isForeignKey: true even when the relation field precedes it', () => {
    const columns = nodesByType(batch, 'DatabaseColumn');
    const authorId = columns.find((c) => c.name === 'authorId');
    expect(authorId?.isForeignKey).toBe(true);
  });

  it('still emits the FOREIGN_KEY edge to Author.id', () => {
    const fks = edgesByType(batch, 'FOREIGN_KEY');
    expect(fks).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// connectionSource: plain-string url behavior (pinned, not asserted-correct)
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — plain-url fixture', () => {
  it('captures a plain-string datasource url including its embedded quotes', () => {
    // This pins current behavior. The parser's underlying AST keeps the
    // surrounding double-quotes on string literals; stringifyValue does
    // not strip them for `url`. Downstream consumers should treat
    // connectionSource as an opaque string anyway.
    const batch = extractPrismaSchemas({ rootDir: fixturePath('plain-url') });
    const system = nodesByType(batch, 'DatabaseSystem')[0];
    expect(system.connectionSource).toBe('"postgresql://user:pass@host:5432/mydb"');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Error handling: malformed schema files propagate the parser error
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — syntax error handling', () => {
  it('propagates parser errors on a malformed schema.prisma', () => {
    // Loud failure is the intended behavior: a broken schema means
    // downstream data would be silently wrong, so we want the agent
    // pipeline to surface the error and halt this plugin.
    expect(() => extractPrismaSchemas({ rootDir: fixturePath('syntax-error') })).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// #325 — prismaSchemaFolder preview layout
//
// dub, formbricks, and several other monorepos use Prisma's
// `prismaSchemaFolder` preview: the datasource lives in `schema.prisma`
// alone and the actual models are split across sibling `.prisma`
// shards (`user.prisma`, `post.prisma`, etc.). Pre-#325 the parser
// processed each file in isolation and silently dropped the shards
// because they had no local datasource block.
//
// The two-pass extractor must:
//   - locate the datasource cross-file (pass 1),
//   - attribute every shard's models to it (pass 2),
//   - resolve cross-shard `@relation`s (`Post.author User`).
// ──────────────────────────────────────────────────────────────────────

describe('extractPrismaSchemas — prismaSchemaFolder fixture (#325)', () => {
  const batch = extractPrismaSchemas({ rootDir: fixturePath('schema-folder') });

  it('emits exactly one DatabaseSystem from the (datasource-only) schema.prisma', () => {
    const systems = nodesByType(batch, 'DatabaseSystem');
    expect(systems).toHaveLength(1);
    expect(systems[0].kind).toBe('postgres');
  });

  it('extracts models from every shard, not just the file with the datasource', () => {
    const tables = nodesByType(batch, 'DatabaseTable');
    expect(tables.map((t) => t.name).sort()).toEqual(['Post', 'User']);
  });

  it('resolves @relation across shard boundaries (Post.author → User.id)', () => {
    const fks = edgesByType(batch, 'FOREIGN_KEY');
    expect(fks).toHaveLength(1);
    // The relation lives in `post.prisma`; its target model `User`
    // lives in `user.prisma`. Cross-file `modelNames` lookup is the
    // only way this resolves.
    const tables = nodesByType(batch, 'DatabaseTable');
    const postTable = tables.find((t) => t.name === 'Post')!;
    const userTable = tables.find((t) => t.name === 'User')!;
    const authorIdColumn = idFor.databaseColumn({ tableId: postTable.id, name: 'authorId' });
    const userIdColumn = idFor.databaseColumn({ tableId: userTable.id, name: 'id' });
    expect(fks[0].from).toBe(authorIdColumn);
    expect(fks[0].to).toBe(userIdColumn);
  });

  it('attributes every model to the cross-file DatabaseSystem (TABLE_IN edges)', () => {
    const system = nodesByType(batch, 'DatabaseSystem')[0];
    const tables = nodesByType(batch, 'DatabaseTable');
    const tableIn = edgesByType(batch, 'TABLE_IN');
    expect(tableIn).toHaveLength(tables.length);
    for (const t of tables) {
      expect(tableIn.some((e) => e.from === t.id && e.to === system.id)).toBe(true);
    }
  });

  it('records the schema file path in declaredIn (each table points at its shard)', () => {
    const tables = nodesByType(batch, 'DatabaseTable');
    const userTable = tables.find((t) => t.name === 'User');
    const postTable = tables.find((t) => t.name === 'Post');
    expect(userTable?.declaredIn).toMatch(/user\.prisma$/);
    expect(postTable?.declaredIn).toMatch(/post\.prisma$/);
  });

  // Reviewer gap: with the two-pass design, a folder whose files
  // contain models but NO datasource (anywhere) silently produces
  // an empty batch. Pin that contract so a future regression that
  // started emitting orphan tables would fail loudly.
  it('returns an empty batch when no file carries a datasource block', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-no-ds-'));
    try {
      await fs.mkdir(path.join(tmp, 'prisma'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'prisma/user.prisma'),
        'model User {\n  id Int @id\n}\n',
      );
      await fs.writeFile(
        path.join(tmp, 'prisma/post.prisma'),
        'model Post {\n  id Int @id\n}\n',
      );
      const b = extractPrismaSchemas({ rootDir: tmp });
      expect(b.nodes).toEqual([]);
      expect(b.edges).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Reviewer gap: when the same model name appears in two shards
  // (e.g., a shard accidentally duplicated during a merge), the
  // batch must dedupe to ONE table — content-addressed ids and
  // the `pushNode` map both rely on this. `declaredIn` records
  // whichever shard was seen first (deterministic via sorted
  // findSchemaFiles).
  it('deduplicates when the same model appears in two shards', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-dup-model-'));
    try {
      await fs.mkdir(path.join(tmp, 'prisma'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'prisma/schema.prisma'),
        [
          'datasource db {',
          '  provider = "postgresql"',
          '  url      = env("DATABASE_URL")',
          '}',
          '',
          'generator client {',
          '  provider = "prisma-client-js"',
          '}',
          '',
        ].join('\n'),
      );
      // Two shards both declaring `model User { id Int @id }`.
      await fs.writeFile(
        path.join(tmp, 'prisma/users-a.prisma'),
        'model User {\n  id Int @id\n}\n',
      );
      await fs.writeFile(
        path.join(tmp, 'prisma/users-b.prisma'),
        'model User {\n  id Int @id\n}\n',
      );
      const b = extractPrismaSchemas({ rootDir: tmp });
      const tables = b.nodes.filter((n) => n.nodeType === 'DatabaseTable');
      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe('User');
      // First shard (alphabetical) wins for `declaredIn`.
      expect(tables[0].declaredIn).toMatch(/users-a\.prisma$/);
      const tableIn = b.edges.filter((e) => e.edgeType === 'TABLE_IN');
      expect(tableIn).toHaveLength(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Reviewer gap: a behavior change vs the prior parser. When TWO
  // shards each declare their own datasource, the old parser
  // emitted two `DatabaseSystem` nodes and split models between
  // them. The new two-pass picks the FIRST datasource in sorted
  // file order and attributes ALL models to it (Prisma supports
  // only one datasource per project, so this is more correct).
  // Pin the new contract so the behavior change is intentional
  // and a future revert would fail.
  it('picks the first datasource across files and attributes all models to it', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-multi-ds-'));
    try {
      await fs.mkdir(path.join(tmp, 'prisma'), { recursive: true });
      // a.prisma — postgres datasource + User
      await fs.writeFile(
        path.join(tmp, 'prisma/a.prisma'),
        [
          'datasource alpha {',
          '  provider = "postgresql"',
          '  url      = env("PG_URL")',
          '}',
          '',
          'model UserA {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );
      // b.prisma — sqlite datasource (would have been picked in
      // the old per-file logic too, since it's first in its own
      // file). Distinct kind so the systemId differs from a.prisma.
      await fs.writeFile(
        path.join(tmp, 'prisma/b.prisma'),
        [
          'datasource beta {',
          '  provider = "sqlite"',
          '  url      = "file:./dev.db"',
          '}',
          '',
          'model UserB {',
          '  id Int @id',
          '}',
          '',
        ].join('\n'),
      );
      const b = extractPrismaSchemas({ rootDir: tmp });
      const systems = b.nodes.filter((n) => n.nodeType === 'DatabaseSystem');
      const tables = b.nodes.filter((n) => n.nodeType === 'DatabaseTable');
      // Exactly one system survives; the alphabetically-first
      // file's datasource (alpha, postgres) wins.
      expect(systems).toHaveLength(1);
      expect((systems[0] as { kind?: string }).kind).toBe('postgres');
      expect((systems[0] as { name?: string }).name).toBe('alpha');
      // Both models attribute to that surviving system.
      expect(tables.map((t) => t.name).sort()).toEqual(['UserA', 'UserB']);
      const systemId = systems[0].id;
      for (const t of tables) {
        expect((t as { systemId?: string }).systemId).toBe(systemId);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// findSchemaFiles recursive flag
// ──────────────────────────────────────────────────────────────────────

describe('findSchemaFiles — recursive flag', () => {
  it('recursive=true walks the full tree by default', () => {
    const files = findSchemaFiles(fixturePath('multi-schema'));
    expect(files).toHaveLength(2);
  });

  it('recursive=false still discovers ./prisma/schema.prisma (canonical layout)', () => {
    const files = findSchemaFiles(fixturePath('postgres-basic'), false);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/schema\.prisma$/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findCanonicalPrismaSchemas (#344)
// ──────────────────────────────────────────────────────────────────────

describe('findCanonicalPrismaSchemas', () => {
  it('finds canonical schema.prisma under a workspace', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-find-canonical-'));
    try {
      await fs.mkdir(path.join(tmp, 'packages/prisma'), { recursive: true });
      const schemaPath = path.join(tmp, 'packages/prisma/schema.prisma');
      await fs.writeFile(schemaPath, '');
      const found = findCanonicalPrismaSchemas(tmp);
      expect(found).toEqual([schemaPath]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('finds multiple canonical schemas in distinct sub-packages', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-find-multi-'));
    try {
      await fs.mkdir(path.join(tmp, 'packages/a/prisma'), { recursive: true });
      await fs.mkdir(path.join(tmp, 'packages/b/prisma'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'packages/a/prisma/schema.prisma'), '');
      await fs.writeFile(path.join(tmp, 'packages/b/prisma/schema.prisma'), '');
      const found = findCanonicalPrismaSchemas(tmp);
      expect(found).toHaveLength(2);
      expect(found.every((f) => f.endsWith('schema.prisma'))).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('skips stray .prisma files outside a prisma/ directory', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-find-stray-'));
    try {
      await fs.writeFile(path.join(tmp, 'fixtures.prisma'), '');
      await fs.mkdir(path.join(tmp, 'packages/prisma'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'packages/prisma/schema.prisma'), '');
      const found = findCanonicalPrismaSchemas(tmp);
      // Stray fixtures.prisma is NOT included; canonical one IS.
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/packages\/prisma\/schema\.prisma$/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('skips node_modules and dotfiles', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-find-skips-'));
    try {
      await fs.mkdir(path.join(tmp, 'node_modules/dep/prisma'), { recursive: true });
      await fs.mkdir(path.join(tmp, '.cache/prisma'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'node_modules/dep/prisma/schema.prisma'), '');
      await fs.writeFile(path.join(tmp, '.cache/prisma/schema.prisma'), '');
      const found = findCanonicalPrismaSchemas(tmp);
      expect(found).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty for a workspace with no schemas', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adorable-find-none-'));
    try {
      await fs.mkdir(path.join(tmp, 'apps/web'), { recursive: true });
      const found = findCanonicalPrismaSchemas(tmp);
      expect(found).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// PrismaPlugin.appliesTo fallback via ctx.files
// ──────────────────────────────────────────────────────────────────────

describe('PrismaPlugin.appliesTo — ctx.files fallback', () => {
  it('detects a non-standard schema location via ctx.files', () => {
    const plugin = new PrismaPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere-on-disk',
        packageJson: null,
        files: ['src/db/schema.prisma'],
      })
    ).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: commit schema batch to the canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('schema batch commits cleanly and round-trips via the canonical store', () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new PrismaPlugin();
      const batch = plugin.extractSchemas(fixturePath('postgres-basic'));
      store.commit(batch, makeBatchMeta(plugin.id));

      const systems = store.findNodes('DatabaseSystem');
      expect(systems).toHaveLength(1);
      expect(systems[0].kind).toBe('postgres');

      const tables = store.findNodes('DatabaseTable');
      expect(tables.map((t: DatabaseTable) => t.name).sort()).toEqual(['Post', 'User']);

      const columns = store.findNodes('DatabaseColumn');
      // 8 scalar columns across User + Post (see postgres-basic test).
      expect(columns).toHaveLength(8);

      // FOREIGN_KEY edges queryable.
      const fks = store.findEdges(null, null, 'FOREIGN_KEY') as ForeignKeyEdge[];
      expect(fks).toHaveLength(1);
      expect(fks[0].onDelete).toBe('Cascade');

      // Batch metadata attributed to the Prisma plugin.
      const batches = store.listBatches();
      expect(batches).toHaveLength(1);
      expect(batches[0].producedBy).toBe('prisma');
    } finally {
      store.close();
    }
  });

  it('committing the same schema batch twice is idempotent', () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new PrismaPlugin();
      const batch = plugin.extractSchemas(fixturePath('postgres-basic'));
      store.commit(batch, makeBatchMeta(plugin.id));
      store.commit(batch, makeBatchMeta(plugin.id));
      expect(store.findNodes('DatabaseSystem')).toHaveLength(1);
      expect(store.findNodes('DatabaseTable')).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

