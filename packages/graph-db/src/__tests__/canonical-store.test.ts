import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  SchemaValidationError,
  idFor,
  type SchemaEdge,
  type SchemaNode,
} from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '../canonical-store.js';

let store: SQLiteCanonicalGraphStore;

beforeEach(() => {
  store = new SQLiteCanonicalGraphStore(':memory:');
});

afterEach(() => {
  store.close();
});

// ──────────────────────────────────────────────────────────────────────
// Fixture builders
// ──────────────────────────────────────────────────────────────────────

const repo = 'adorable';

function buildSourceFile(filePath = 'src/users.ts'): SchemaNode {
  return {
    nodeType: 'SourceFile',
    id: idFor.sourceFile({ repository: repo, filePath }),
    filePath,
    repository: repo,
    language: 'ts',
    framework: null,
  };
}

function buildFunction(
  sourceFileId: string,
  name = 'getUser',
  sourceLine = 10
): SchemaNode {
  return {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId, name, sourceLine }),
    name,
    sourceFileId,
    sourceLine,
    parameters: [{ name: 'id', type: 'string' }],
    returnType: 'Promise<User>',
    isExported: true,
    isAsync: true,
  };
}

function buildEndpoint(routePattern = '/users/:id', method = 'GET'): SchemaNode {
  return {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({ repository: repo, httpMethod: method, routePattern, filePath: 'a.ts', lineStart: 1 }),
    httpMethod: method,
    routePattern,
    handlerFunctionId: null,
    framework: 'express',
    repository: repo,
  };
}

function buildBatch(nodes: SchemaNode[], edges: SchemaEdge[] = []): NodeBatch {
  return { nodes, edges };
}

// ──────────────────────────────────────────────────────────────────────
// commit
// ──────────────────────────────────────────────────────────────────────

describe('commit — happy path', () => {
  it('persists nodes from a batch', () => {
    const file = buildSourceFile();
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    expect(store.getNode('SourceFile', file.id)).toEqual(file);
  });

  it('persists edges from a batch', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const edge: SchemaEdge = { edgeType: 'DEFINED_IN', from: fn.id, to: file.id };
    store.commit(buildBatch([file, fn], [edge]), makeBatchMeta('ts'));
    expect(store.findEdges(fn.id, file.id, 'DEFINED_IN')).toHaveLength(1);
  });

  it('records BatchMeta and counts in the batches table', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    store.commit(
      buildBatch([file, fn], [{ edgeType: 'DEFINED_IN', from: fn.id, to: file.id }]),
      makeBatchMeta('ts')
    );
    const batches = store.listBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].schemaVersion).toBe(SCHEMA_VERSION);
    expect(batches[0].producedBy).toBe('ts');
    expect(batches[0].nodeCount).toBe(2);
    expect(batches[0].edgeCount).toBe(1);
  });

  it('accepts an empty batch and records it', () => {
    store.commit({ nodes: [], edges: [] }, makeBatchMeta('ts'));
    expect(store.listBatches()).toHaveLength(1);
  });
});

describe('commit — idempotency', () => {
  it('committing the same batch twice produces the same graph state', () => {
    const file = buildSourceFile();
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    const all = store.findNodes('SourceFile');
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(file);
  });

  it('committing the same edge twice produces a single row', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const edge: SchemaEdge = { edgeType: 'DEFINED_IN', from: fn.id, to: file.id };
    store.commit(buildBatch([file, fn], [edge]), makeBatchMeta('ts'));
    store.commit(buildBatch([file, fn], [edge]), makeBatchMeta('ts'));
    expect(store.findEdges(fn.id, file.id)).toHaveLength(1);
  });

  it('upserts a node when content changes (same id, different fields)', () => {
    const fileV1 = buildSourceFile();
    const fileV2 = { ...fileV1, framework: 'next' };
    store.commit(buildBatch([fileV1]), makeBatchMeta('ts'));
    store.commit(buildBatch([fileV2]), makeBatchMeta('ts'));
    const stored = store.getNode('SourceFile', fileV1.id);
    expect(stored?.framework).toBe('next');
  });

  it('two CALLS_FUNCTION edges between the same functions at different lines are distinct', () => {
    const file = buildSourceFile();
    const f1 = buildFunction(file.id, 'caller', 5);
    const f2 = buildFunction(file.id, 'callee', 20);
    const e1: SchemaEdge = {
      edgeType: 'CALLS_FUNCTION',
      from: f1.id,
      to: f2.id,
      sourceLine: 6,
      arguments: [],
      isConditional: false,
      confidence: 'direct',
    };
    const e2: SchemaEdge = { ...e1, sourceLine: 7 };
    store.commit(buildBatch([file, f1, f2], [e1, e2]), makeBatchMeta('ts'));
    expect(store.findEdges(f1.id, f2.id, 'CALLS_FUNCTION')).toHaveLength(2);
  });
});

describe('commit — validation and rollback', () => {
  it('throws SchemaValidationError on a malformed node', () => {
    const bad = { nodeType: 'SourceFile', id: 'x' } as unknown as SchemaNode;
    expect(() => store.commit(buildBatch([bad]), makeBatchMeta('ts'))).toThrow(
      SchemaValidationError
    );
  });

  it('throws SchemaValidationError on a malformed edge', () => {
    const file = buildSourceFile();
    const badEdge = { edgeType: 'DEFINED_IN', from: file.id } as unknown as SchemaEdge;
    expect(() => store.commit(buildBatch([file], [badEdge]), makeBatchMeta('ts'))).toThrow(
      SchemaValidationError
    );
  });

  it('rolls the entire transaction back on validation failure', () => {
    const file = buildSourceFile();
    const bad = { nodeType: 'NotAThing' } as unknown as SchemaNode;
    expect(() => store.commit(buildBatch([file, bad]), makeBatchMeta('ts'))).toThrow(
      SchemaValidationError
    );
    // Neither the valid node nor a batch row should be present.
    expect(store.findNodes('SourceFile')).toHaveLength(0);
    expect(store.listBatches()).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// getNode
// ──────────────────────────────────────────────────────────────────────

describe('getNode', () => {
  it('returns the node when present', () => {
    const file = buildSourceFile();
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    expect(store.getNode('SourceFile', file.id)).toEqual(file);
  });

  it('returns null when no node has the id', () => {
    expect(store.getNode('SourceFile', 'SourceFile:doesnotexist')).toBeNull();
  });

  it('returns null when the id exists but the type does not match', () => {
    const file = buildSourceFile();
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    // Asking for a FunctionDefinition with the SourceFile's id must miss.
    expect(store.getNode('FunctionDefinition', file.id)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// findNodes
// ──────────────────────────────────────────────────────────────────────

describe('findNodes', () => {
  it('returns every node of the type when no filter is given', () => {
    const a = buildSourceFile('a.ts');
    const b = buildSourceFile('b.ts');
    store.commit(buildBatch([a, b]), makeBatchMeta('ts'));
    const result = store.findNodes('SourceFile');
    expect(result).toHaveLength(2);
  });

  it('filters by a single property', () => {
    const a = buildSourceFile('a.ts');
    const b = buildSourceFile('b.ts');
    store.commit(buildBatch([a, b]), makeBatchMeta('ts'));
    const result = store.findNodes('SourceFile', { filePath: 'a.ts' });
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('a.ts');
  });

  it('filters by multiple properties (AND semantics)', () => {
    const a = buildSourceFile('a.ts');
    const b: SchemaNode = { ...buildSourceFile('a.ts'), repository: 'other-repo', id: 'SourceFile:other' };
    store.commit(buildBatch([a, b]), makeBatchMeta('ts'));
    const result = store.findNodes('SourceFile', { filePath: 'a.ts', repository: 'adorable' });
    expect(result).toHaveLength(1);
    expect(result[0].repository).toBe('adorable');
  });

  it('returns empty when no node matches', () => {
    store.commit(buildBatch([buildSourceFile()]), makeBatchMeta('ts'));
    expect(store.findNodes('SourceFile', { filePath: 'nope.ts' })).toEqual([]);
  });

  it('returns empty when no node of the type exists', () => {
    expect(store.findNodes('APIEndpoint')).toEqual([]);
  });

  it('does not return nodes of a different type', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    store.commit(buildBatch([file, fn]), makeBatchMeta('ts'));
    expect(store.findNodes('FunctionDefinition')).toHaveLength(1);
    expect(store.findNodes('SourceFile')).toHaveLength(1);
  });

  it('matches a null property correctly via IS NULL', () => {
    const file = buildSourceFile(); // framework: null
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    const result = store.findNodes('SourceFile', { framework: null });
    expect(result).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findEdges
// ──────────────────────────────────────────────────────────────────────

describe('findEdges', () => {
  function seed() {
    const file = buildSourceFile();
    const f1 = buildFunction(file.id, 'a', 5);
    const f2 = buildFunction(file.id, 'b', 15);
    const f3 = buildFunction(file.id, 'c', 25);
    const definedIn1: SchemaEdge = { edgeType: 'DEFINED_IN', from: f1.id, to: file.id };
    const definedIn2: SchemaEdge = { edgeType: 'DEFINED_IN', from: f2.id, to: file.id };
    const calls12: SchemaEdge = {
      edgeType: 'CALLS_FUNCTION',
      from: f1.id,
      to: f2.id,
      sourceLine: 6,
      arguments: [],
      isConditional: false,
      confidence: 'direct',
    };
    const calls13: SchemaEdge = { ...calls12, to: f3.id };
    store.commit(
      buildBatch([file, f1, f2, f3], [definedIn1, definedIn2, calls12, calls13]),
      makeBatchMeta('ts')
    );
    return { file, f1, f2, f3 };
  }

  it('returns all edges when both endpoints are null', () => {
    seed();
    expect(store.findEdges(null, null)).toHaveLength(4);
  });

  it('filters by `from` only', () => {
    const { f1 } = seed();
    const result = store.findEdges(f1.id, null);
    // f1 → file (DEFINED_IN), f1 → f2 (CALLS), f1 → f3 (CALLS)
    expect(result).toHaveLength(3);
  });

  it('filters by `to` only', () => {
    const { file } = seed();
    const result = store.findEdges(null, file.id);
    expect(result).toHaveLength(2); // f1 → file and f2 → file
  });

  it('filters by both `from` and `to`', () => {
    const { f1, f2 } = seed();
    const result = store.findEdges(f1.id, f2.id);
    expect(result).toHaveLength(1);
  });

  it('filters by edge type', () => {
    const { f1 } = seed();
    const result = store.findEdges(f1.id, null, 'CALLS_FUNCTION');
    expect(result).toHaveLength(2);
  });

  it('combines from + to + type', () => {
    const { f1, f2 } = seed();
    const result = store.findEdges(f1.id, f2.id, 'CALLS_FUNCTION');
    expect(result).toHaveLength(1);
  });

  it('returns empty when no edge matches', () => {
    seed();
    expect(store.findEdges('nope', 'nope')).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// listBatches
// ──────────────────────────────────────────────────────────────────────

describe('listBatches', () => {
  it('returns batches in commit order', () => {
    store.commit(buildBatch([buildSourceFile('a.ts')]), makeBatchMeta('ts'));
    store.commit(buildBatch([buildSourceFile('b.ts')]), makeBatchMeta('react'));
    const batches = store.listBatches();
    expect(batches.map((b) => b.producedBy)).toEqual(['ts', 'react']);
  });

  it('returns an empty list when nothing has been committed', () => {
    expect(store.listBatches()).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// expectedSchemaVersion
// ──────────────────────────────────────────────────────────────────────

describe('expectedSchemaVersion', () => {
  it('matches the schema package version constant', () => {
    expect(store.expectedSchemaVersion).toBe(SCHEMA_VERSION);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Round-trip integrity
// ──────────────────────────────────────────────────────────────────────

describe('round-trip integrity', () => {
  it('preserves all fields of an APIEndpoint through commit + getNode', () => {
    const endpoint = buildEndpoint();
    store.commit(buildBatch([endpoint]), makeBatchMeta('express'));
    const got = store.getNode('APIEndpoint', endpoint.id);
    expect(got).toEqual(endpoint);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Transactional rollback on a malformed edge mid-batch
// ──────────────────────────────────────────────────────────────────────

describe('commit — rollback on malformed edge', () => {
  it('rolls back the entire batch when a later edge is malformed', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const goodEdge: SchemaEdge = { edgeType: 'DEFINED_IN', from: fn.id, to: file.id };
    const badEdge = { edgeType: 'DEFINED_IN', from: fn.id } as unknown as SchemaEdge;
    expect(() =>
      store.commit(buildBatch([file, fn], [goodEdge, badEdge]), makeBatchMeta('ts'))
    ).toThrow(SchemaValidationError);
    expect(store.findNodes('SourceFile')).toHaveLength(0);
    expect(store.findNodes('FunctionDefinition')).toHaveLength(0);
    expect(store.findEdges(null, null)).toHaveLength(0);
    expect(store.listBatches()).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge content-addressed ID determinism and stability
// ──────────────────────────────────────────────────────────────────────

describe('edge content-addressed id', () => {
  it('is deterministic across separate store instances', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const edge: SchemaEdge = { edgeType: 'DEFINED_IN', from: fn.id, to: file.id };
    const s2 = new SQLiteCanonicalGraphStore(':memory:');
    try {
      store.commit(buildBatch([file, fn], [edge]), makeBatchMeta('ts'));
      s2.commit(buildBatch([file, fn], [edge]), makeBatchMeta('ts'));
      const id1 = (
        store as unknown as { db: Database.Database }
      ).db.prepare('SELECT id FROM canonical_edges').get() as { id: string };
      const id2 = (
        s2 as unknown as { db: Database.Database }
      ).db.prepare('SELECT id FROM canonical_edges').get() as { id: string };
      expect(id1.id).toBe(id2.id);
    } finally {
      s2.close();
    }
  });

  it('is stable across different field declaration orders', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    // Two literals with identical content but different key order.
    const e1: SchemaEdge = {
      edgeType: 'CALLS_FUNCTION',
      from: fn.id,
      to: fn.id,
      sourceLine: 42,
      arguments: ['a', 'b'],
      isConditional: false,
      confidence: 'direct',
    };
    const e2: SchemaEdge = {
      confidence: 'direct',
      isConditional: false,
      arguments: ['a', 'b'],
      sourceLine: 42,
      to: fn.id,
      from: fn.id,
      edgeType: 'CALLS_FUNCTION',
    } as SchemaEdge;
    store.commit(buildBatch([file, fn], [e1]), makeBatchMeta('ts'));
    store.commit(buildBatch([file, fn], [e2]), makeBatchMeta('ts'));
    expect(store.findEdges(fn.id, fn.id, 'CALLS_FUNCTION')).toHaveLength(1);
  });

  it('collides identical edges with array fields into one row', () => {
    const fileA = buildSourceFile('a.ts');
    const fileB = buildSourceFile('b.ts');
    const edge: SchemaEdge = {
      edgeType: 'IMPORTS',
      from: fileA.id,
      to: fileB.id,
      symbols: ['foo', 'bar'],
      isDefault: false,
      isDynamic: false,
    };
    store.commit(buildBatch([fileA, fileB], [edge]), makeBatchMeta('ts'));
    store.commit(buildBatch([fileA, fileB], [{ ...edge }]), makeBatchMeta('ts'));
    expect(store.findEdges(fileA.id, fileB.id, 'IMPORTS')).toHaveLength(1);
  });

  it('distinguishes edges whose array fields differ', () => {
    const fileA = buildSourceFile('a.ts');
    const fileB = buildSourceFile('b.ts');
    const e1: SchemaEdge = {
      edgeType: 'IMPORTS',
      from: fileA.id,
      to: fileB.id,
      symbols: ['foo'],
      isDefault: false,
      isDynamic: false,
    };
    const e2: SchemaEdge = { ...e1, symbols: ['foo', 'bar'] };
    store.commit(buildBatch([fileA, fileB], [e1, e2]), makeBatchMeta('ts'));
    expect(store.findEdges(fileA.id, fileB.id, 'IMPORTS')).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge idempotency with upsert field changes
// ──────────────────────────────────────────────────────────────────────

describe('commit — edge upsert', () => {
  it('updates edge fields in place when the same content-id is committed again', () => {
    // Two CALLS_FUNCTION edges with the same identifying content except
    // for `confidence` — these actually produce distinct ids because
    // `confidence` is part of the edge content. To simulate a true
    // "same identity, new metadata" scenario we commit the same edge
    // twice with a `FOREIGN_KEY` where `onDelete` changes… but
    // `onDelete` is also content, so it changes the id too.
    //
    // The invariant the store guarantees is: identical content ⇒ one
    // row. That is covered elsewhere. Here we instead verify that
    // when the same edge is committed twice, `updated_at` advances and
    // `batch_id` repoints to the newer batch.
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const edge: SchemaEdge = { edgeType: 'DEFINED_IN', from: fn.id, to: file.id };
    store.commit(buildBatch([file, fn], [edge]), makeBatchMeta('ts'));
    store.commit(buildBatch([file, fn], [edge]), makeBatchMeta('ts'));
    const row = (
      store as unknown as { db: Database.Database }
    ).db
      .prepare('SELECT batch_id FROM canonical_edges')
      .get() as { batch_id: number };
    // Second batch's id is 2; the edge row should be repointed to it.
    expect(row.batch_id).toBe(2);
    expect(store.findEdges(fn.id, file.id, 'DEFINED_IN')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// commit with only edges / no nodes
// ──────────────────────────────────────────────────────────────────────

describe('commit — edges without nodes', () => {
  it('allows a batch that contains only edges', () => {
    // Plugins are expected to commit referenced nodes in earlier
    // batches; the store does not enforce an FK from edge endpoints
    // to canonical_nodes. This is intentional.
    const edge: SchemaEdge = {
      edgeType: 'DEFINED_IN',
      from: 'FunctionDefinition:nonexistent',
      to: 'SourceFile:nonexistent',
    };
    expect(() =>
      store.commit({ nodes: [], edges: [edge] }, makeBatchMeta('ts'))
    ).not.toThrow();
    expect(store.findEdges(null, null, 'DEFINED_IN')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-batch node upsert semantics
// ──────────────────────────────────────────────────────────────────────

describe('commit — multi-batch node upsert', () => {
  it('keeps latest content and repoints batch_id, while both batches list', () => {
    const v1 = buildSourceFile();
    const v2 = { ...v1, framework: 'next' };
    store.commit(buildBatch([v1]), makeBatchMeta('ts'));
    store.commit(buildBatch([v2]), makeBatchMeta('react'));
    const got = store.getNode('SourceFile', v1.id);
    expect(got?.framework).toBe('next');
    const row = (
      store as unknown as { db: Database.Database }
    ).db
      .prepare('SELECT batch_id FROM canonical_nodes WHERE id = ?')
      .get(v1.id) as { batch_id: number };
    expect(row.batch_id).toBe(2);
    const batches = store.listBatches();
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.producedBy)).toEqual(['ts', 'react']);
  });

  it('listBatches counts reflect input batch size, not net new rows', () => {
    const file = buildSourceFile();
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    // Re-commit the same node: batch size 1, net new rows 0.
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    const batches = store.listBatches();
    expect(batches).toHaveLength(2);
    expect(batches[0].nodeCount).toBe(1);
    expect(batches[1].nodeCount).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findNodes — extra coverage
// ──────────────────────────────────────────────────────────────────────

describe('findNodes — extra', () => {
  it('filters by a boolean field (isExported = true)', () => {
    const file = buildSourceFile();
    const exported = buildFunction(file.id, 'pub', 10);
    const internal: SchemaNode = {
      ...buildFunction(file.id, 'priv', 20),
      isExported: false,
    };
    store.commit(buildBatch([file, exported, internal]), makeBatchMeta('ts'));
    const hits = store.findNodes('FunctionDefinition', { isExported: true });
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('pub');
  });

  it('filters by a boolean field (isAsync = false)', () => {
    const file = buildSourceFile();
    const sync: SchemaNode = { ...buildFunction(file.id, 's', 10), isAsync: false };
    const async_: SchemaNode = { ...buildFunction(file.id, 'a', 20), isAsync: true };
    store.commit(buildBatch([file, sync, async_]), makeBatchMeta('ts'));
    const hits = store.findNodes('FunctionDefinition', { isAsync: false });
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('s');
  });

  it('skips filter entries whose value is undefined', () => {
    const file = buildSourceFile();
    store.commit(buildBatch([file]), makeBatchMeta('ts'));
    // `framework: undefined` must behave the same as no filter.
    const hits = store.findNodes('SourceFile', {
      filePath: 'src/users.ts',
      framework: undefined,
    } as Partial<Extract<SchemaNode, { nodeType: 'SourceFile' }>>);
    expect(hits).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findEdges — type-only filter
// ──────────────────────────────────────────────────────────────────────

describe('findEdges — type-only filter', () => {
  it('returns all edges of a single type when both endpoints are null', () => {
    const file = buildSourceFile();
    const f1 = buildFunction(file.id, 'a', 5);
    const f2 = buildFunction(file.id, 'b', 15);
    const d1: SchemaEdge = { edgeType: 'DEFINED_IN', from: f1.id, to: file.id };
    const d2: SchemaEdge = { edgeType: 'DEFINED_IN', from: f2.id, to: file.id };
    const c: SchemaEdge = {
      edgeType: 'CALLS_FUNCTION',
      from: f1.id,
      to: f2.id,
      sourceLine: 6,
      arguments: [],
      isConditional: false,
      confidence: 'direct',
    };
    store.commit(buildBatch([file, f1, f2], [d1, d2, c]), makeBatchMeta('ts'));
    expect(store.findEdges(null, null, 'DEFINED_IN')).toHaveLength(2);
    expect(store.findEdges(null, null, 'CALLS_FUNCTION')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Schema-version gate is intentionally open on write (read-time TODO)
// ──────────────────────────────────────────────────────────────────────

describe('schema version gate', () => {
  it('still accepts a batch whose schemaVersion does not match the store', () => {
    // Documented as a TODO in canonical-store.ts: the read-time
    // version check is not yet implemented, so committing with a
    // non-matching version succeeds. If this test starts failing, the
    // gate has been turned on and both this test and the docstring
    // need updating.
    const file = buildSourceFile();
    const meta = { ...makeBatchMeta('ts'), schemaVersion: '999.0.0' };
    expect(() => store.commit(buildBatch([file]), meta)).not.toThrow();
    expect(store.listBatches()[0].schemaVersion).toBe('999.0.0');
  });
});

// ──────────────────────────────────────────────────────────────────────
// close() lifecycle
// ──────────────────────────────────────────────────────────────────────

describe('close lifecycle', () => {
  it('closes the underlying db when constructed from a path', () => {
    const s = new SQLiteCanonicalGraphStore(':memory:');
    const db = (s as unknown as { db: Database.Database }).db;
    s.close();
    expect(db.open).toBe(false);
  });

  it('does NOT close an injected db (caller owns lifecycle)', () => {
    const db = new Database(':memory:');
    try {
      const s = new SQLiteCanonicalGraphStore(db);
      s.close();
      expect(db.open).toBe(true);
      // The injected db should still be usable after store.close().
      expect(db.prepare('SELECT 1 AS v').get()).toEqual({ v: 1 });
    } finally {
      db.close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Round-trip coverage: every node type
// ──────────────────────────────────────────────────────────────────────

describe('round-trip — every node type', () => {
  it('ClientSideAPICaller', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const caller: SchemaNode = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({
        sourceFileId: file.id,
        sourceLine: 12,
        urlLiteral: '/users/1',
      }),
      functionId: fn.id,
      sourceFileId: file.id,
      sourceLine: 12,
      httpMethod: 'GET',
      urlLiteral: '/users/1',
      egressConfidence: 'exact',
      framework: 'fetch',
      repository: repo,
    };
    store.commit(buildBatch([file, fn, caller]), makeBatchMeta('ts'));
    expect(store.getNode('ClientSideAPICaller', caller.id)).toEqual(caller);
  });

  it('ClientSideProcess', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const proc: SchemaNode = {
      nodeType: 'ClientSideProcess',
      id: idFor.clientSideProcess({ sourceFileId: file.id, sourceLine: 30, name: 'onClick' }),
      kind: 'ui_action',
      name: 'onClick',
      functionId: fn.id,
      sourceFileId: file.id,
      sourceLine: 30,
      framework: 'react',
      repository: repo,
    };
    store.commit(buildBatch([file, fn, proc]), makeBatchMeta('react'));
    expect(store.getNode('ClientSideProcess', proc.id)).toEqual(proc);
  });

  it('DatabaseSystem / DatabaseTable / DatabaseColumn', () => {
    const sys: SchemaNode = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'main' }),
      kind: 'postgres',
      name: 'main',
      connectionSource: 'env:DATABASE_URL',
    };
    const tbl: SchemaNode = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: sys.id, schema: 'public', name: 'users' }),
      systemId: sys.id,
      name: 'users',
      schema: 'public',
      kind: 'table',
      declaredIn: null,
    };
    const col: SchemaNode = {
      nodeType: 'DatabaseColumn',
      id: idFor.databaseColumn({ tableId: tbl.id, name: 'id' }),
      tableId: tbl.id,
      name: 'id',
      type: 'int',
      nullable: false,
      isPrimaryKey: true,
      isForeignKey: false,
    };
    store.commit(buildBatch([sys, tbl, col]), makeBatchMeta('prisma'));
    expect(store.getNode('DatabaseSystem', sys.id)).toEqual(sys);
    expect(store.getNode('DatabaseTable', tbl.id)).toEqual(tbl);
    expect(store.getNode('DatabaseColumn', col.id)).toEqual(col);
  });

  it('DatabaseInteraction', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const sys: SchemaNode = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'main' }),
      kind: 'postgres',
      name: 'main',
      connectionSource: null,
    };
    const tbl: SchemaNode = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: sys.id, schema: null, name: 'users' }),
      systemId: sys.id,
      name: 'users',
      schema: null,
      kind: 'table',
      declaredIn: null,
    };
    const interaction: SchemaNode = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: fn.id,
        operation: 'read',
        targetTableId: tbl.id,
      }),
      callSiteFunctionId: fn.id,
      operation: 'read',
      orm: 'prisma',
      rawQuery: null,
      confidence: 'direct',
    };
    store.commit(buildBatch([file, fn, sys, tbl, interaction]), makeBatchMeta('prisma'));
    expect(store.getNode('DatabaseInteraction', interaction.id)).toEqual(interaction);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Round-trip coverage: every edge type
// ──────────────────────────────────────────────────────────────────────

describe('round-trip — every edge type', () => {
  it('IMPORTS / EXPORTS / DEFINED_IN', () => {
    const fileA = buildSourceFile('a.ts');
    const fileB = buildSourceFile('b.ts');
    const fn = buildFunction(fileA.id);
    const imports: SchemaEdge = {
      edgeType: 'IMPORTS',
      from: fileA.id,
      to: fileB.id,
      symbols: ['x', 'y'],
      isDefault: false,
      isDynamic: false,
    };
    const exports_: SchemaEdge = {
      edgeType: 'EXPORTS',
      from: fileA.id,
      to: fn.id,
      exportName: 'getUser',
      isDefault: true,
    };
    const definedIn: SchemaEdge = { edgeType: 'DEFINED_IN', from: fn.id, to: fileA.id };
    store.commit(
      buildBatch([fileA, fileB, fn], [imports, exports_, definedIn]),
      makeBatchMeta('ts')
    );
    const all = store.findEdges(null, null);
    expect(all).toHaveLength(3);
    // Array field round-trip preserved.
    const roundTrippedImports = store.findEdges(fileA.id, fileB.id, 'IMPORTS')[0] as {
      symbols: string[];
    };
    expect(roundTrippedImports.symbols).toEqual(['x', 'y']);
  });

  it('RESOLVES_TO_ENDPOINT', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const endpoint = buildEndpoint();
    const caller: SchemaNode = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({
        sourceFileId: file.id,
        sourceLine: 12,
        urlLiteral: '/users/1',
      }),
      functionId: fn.id,
      sourceFileId: file.id,
      sourceLine: 12,
      httpMethod: 'GET',
      urlLiteral: '/users/1',
      egressConfidence: 'exact',
      framework: 'fetch',
      repository: repo,
    };
    const edge: SchemaEdge = {
      edgeType: 'RESOLVES_TO_ENDPOINT',
      from: caller.id,
      to: endpoint.id,
      matchedBy: 'exact-url',
      matchConfidence: 'high',
    };
    store.commit(buildBatch([file, fn, caller, endpoint], [edge]), makeBatchMeta('stitcher'));
    expect(store.findEdges(caller.id, endpoint.id, 'RESOLVES_TO_ENDPOINT')).toHaveLength(1);
  });

  it('TABLE_IN / COLUMN_IN / FOREIGN_KEY / READS / WRITES / PERFORMED_BY', () => {
    const file = buildSourceFile();
    const fn = buildFunction(file.id);
    const sys: SchemaNode = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'main' }),
      kind: 'postgres',
      name: 'main',
      connectionSource: null,
    };
    const users: SchemaNode = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: sys.id, schema: null, name: 'users' }),
      systemId: sys.id,
      name: 'users',
      schema: null,
      kind: 'table',
      declaredIn: null,
    };
    const orders: SchemaNode = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: sys.id, schema: null, name: 'orders' }),
      systemId: sys.id,
      name: 'orders',
      schema: null,
      kind: 'table',
      declaredIn: null,
    };
    const userId: SchemaNode = {
      nodeType: 'DatabaseColumn',
      id: idFor.databaseColumn({ tableId: users.id, name: 'id' }),
      tableId: users.id,
      name: 'id',
      type: 'int',
      nullable: false,
      isPrimaryKey: true,
      isForeignKey: false,
    };
    const orderUserId: SchemaNode = {
      nodeType: 'DatabaseColumn',
      id: idFor.databaseColumn({ tableId: orders.id, name: 'user_id' }),
      tableId: orders.id,
      name: 'user_id',
      type: 'int',
      nullable: false,
      isPrimaryKey: false,
      isForeignKey: true,
    };
    const interaction: SchemaNode = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: fn.id,
        operation: 'read',
        targetTableId: users.id,
      }),
      callSiteFunctionId: fn.id,
      operation: 'read',
      orm: 'prisma',
      rawQuery: null,
      confidence: 'direct',
    };

    const tableIn: SchemaEdge = { edgeType: 'TABLE_IN', from: users.id, to: sys.id };
    const columnIn: SchemaEdge = { edgeType: 'COLUMN_IN', from: userId.id, to: users.id };
    const foreignKey: SchemaEdge = {
      edgeType: 'FOREIGN_KEY',
      from: orderUserId.id,
      to: userId.id,
      onDelete: 'CASCADE',
      onUpdate: null,
    };
    const reads: SchemaEdge = {
      edgeType: 'READS',
      from: interaction.id,
      to: users.id,
      columns: ['id', 'email'],
      filters: 'id = ?',
    };
    const writes: SchemaEdge = {
      edgeType: 'WRITES',
      from: interaction.id,
      to: users.id,
      columns: ['email'],
      kind: 'update',
    };
    const performedBy: SchemaEdge = {
      edgeType: 'PERFORMED_BY',
      from: interaction.id,
      to: fn.id,
      sourceLine: 99,
    };
    store.commit(
      buildBatch(
        [file, fn, sys, users, orders, userId, orderUserId, interaction],
        [tableIn, columnIn, foreignKey, reads, writes, performedBy]
      ),
      makeBatchMeta('prisma')
    );
    expect(store.findEdges(null, null)).toHaveLength(6);
    const readsBack = store.findEdges(interaction.id, users.id, 'READS')[0] as {
      columns: string[] | null;
    };
    expect(readsBack.columns).toEqual(['id', 'email']);
    const writesBack = store.findEdges(interaction.id, users.id, 'WRITES')[0] as {
      columns: string[] | null;
    };
    expect(writesBack.columns).toEqual(['email']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// deleteByRepository (#104)
// ──────────────────────────────────────────────────────────────────────

describe('deleteByRepository', () => {
  it('deletes all nodes and edges for the specified repository', () => {
    const repoA = 'repo-a';
    const repoB = 'repo-b';

    const fileA: SchemaNode = {
      nodeType: 'SourceFile',
      id: idFor.sourceFile({ repository: repoA, filePath: 'src/a.ts' }),
      filePath: 'src/a.ts',
      repository: repoA,
      language: 'ts',
      framework: null,
    };
    const fileB: SchemaNode = {
      nodeType: 'SourceFile',
      id: idFor.sourceFile({ repository: repoB, filePath: 'src/b.ts' }),
      filePath: 'src/b.ts',
      repository: repoB,
      language: 'ts',
      framework: null,
    };
    const fnA: SchemaNode = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId: fileA.id, name: 'fnA', sourceLine: 1 }),
      name: 'fnA',
      sourceFileId: fileA.id,
      sourceLine: 1,
      parameters: [],
      returnType: null,
      isExported: true,
      isAsync: false,
    };
    const edgeA: SchemaEdge = {
      edgeType: 'DEFINED_IN',
      from: fnA.id,
      to: fileA.id,
    };

    store.commit({ nodes: [fileA, fnA], edges: [edgeA] }, makeBatchMeta('test'));
    store.commit({ nodes: [fileB], edges: [] }, makeBatchMeta('test'));

    // Both repos' nodes exist.
    expect(store.findNodes('SourceFile')).toHaveLength(2);

    // Delete repo A.
    const result = store.deleteByRepository(repoA);
    expect(result.deletedNodes).toBe(2); // fileA + fnA
    expect(result.deletedEdges).toBeGreaterThanOrEqual(1);

    // Only repo B remains.
    expect(store.findNodes('SourceFile')).toHaveLength(1);
    expect(store.findNodes('SourceFile')[0].id).toBe(fileB.id);
    expect(store.findNodes('FunctionDefinition')).toHaveLength(0);
    expect(store.findEdges(fnA.id, null)).toHaveLength(0);
  });

  it('returns zero counts when the repository does not exist', () => {
    const result = store.deleteByRepository('nonexistent');
    expect(result.deletedNodes).toBe(0);
    expect(result.deletedEdges).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// deleteByFile / source-file hash CRUD (#294 Phase 2a)
// ──────────────────────────────────────────────────────────────────────

describe('deleteByFile', () => {
  it('deletes the SourceFile and every node referencing its sourceFileId', () => {
    const repo = 'r';
    const fileA: SchemaNode = {
      nodeType: 'SourceFile',
      id: idFor.sourceFile({ repository: repo, filePath: 'src/a.ts' }),
      filePath: 'src/a.ts',
      repository: repo,
      language: 'ts',
      framework: null,
    };
    const fnA: SchemaNode = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId: fileA.id, name: 'fnA', sourceLine: 1 }),
      name: 'fnA',
      sourceFileId: fileA.id,
      sourceLine: 1,
      parameters: [],
      returnType: null,
      isExported: true,
      isAsync: false,
    };
    const fileB: SchemaNode = {
      nodeType: 'SourceFile',
      id: idFor.sourceFile({ repository: repo, filePath: 'src/b.ts' }),
      filePath: 'src/b.ts',
      repository: repo,
      language: 'ts',
      framework: null,
    };
    const edge: SchemaEdge = { edgeType: 'DEFINED_IN', from: fnA.id, to: fileA.id };
    store.commit({ nodes: [fileA, fnA, fileB], edges: [edge] }, makeBatchMeta('test'));

    const result = store.deleteByFile(repo, 'src/a.ts');
    expect(result.deletedNodes).toBe(2);
    expect(result.deletedEdges).toBeGreaterThanOrEqual(1);
    expect(store.findNodes('SourceFile').map((s) => s.filePath)).toEqual(['src/b.ts']);
    expect(store.findNodes('FunctionDefinition')).toHaveLength(0);
  });

  it('returns zero counts when no SourceFile matches', () => {
    const result = store.deleteByFile('nonexistent', 'src/x.ts');
    expect(result.deletedNodes).toBe(0);
    expect(result.deletedEdges).toBe(0);
  });

  it('also deletes nodes referencing the file via `declaredIn`', () => {
    const repo = 'r';
    const file: SchemaNode = {
      nodeType: 'SourceFile',
      id: idFor.sourceFile({ repository: repo, filePath: 'src/schema.ts' }),
      filePath: 'src/schema.ts',
      repository: repo,
      language: 'ts',
      framework: null,
    };
    const table: SchemaNode = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: 'sys-id', schema: null, name: 'users' }),
      name: 'users',
      systemId: 'sys-id',
      schema: null,
      kind: 'table',
      declaredIn: file.id,
    };
    store.commit({ nodes: [file, table], edges: [] }, makeBatchMeta('test'));

    const result = store.deleteByFile(repo, 'src/schema.ts');
    expect(result.deletedNodes).toBe(2);
    expect(store.findNodes('DatabaseTable')).toHaveLength(0);
    expect(store.findNodes('SourceFile')).toHaveLength(0);
  });
});

describe('source-file hash CRUD (incremental sidecar)', () => {
  it('upsert + read round-trip', () => {
    store.setSourceFileHash('r', 'src/a.ts', 'hash-a-v1', '1.0.0');
    expect(store.getSourceFileHash('r', 'src/a.ts')).toEqual({ hash: 'hash-a-v1', schemaVersion: '1.0.0' });
    // Overwrite
    store.setSourceFileHash('r', 'src/a.ts', 'hash-a-v2', '1.0.0');
    expect(store.getSourceFileHash('r', 'src/a.ts')?.hash).toBe('hash-a-v2');
  });

  it('returns null when no row exists', () => {
    expect(store.getSourceFileHash('r', 'src/missing.ts')).toBeNull();
  });

  it('list returns only the requested repository', () => {
    store.setSourceFileHash('r1', 'src/a.ts', 'hash-a', '1.0.0');
    store.setSourceFileHash('r1', 'src/b.ts', 'hash-b', '1.0.0');
    store.setSourceFileHash('r2', 'src/c.ts', 'hash-c', '1.0.0');

    const r1 = store.listSourceFileHashes('r1').map((r) => r.filePath).sort();
    const r2 = store.listSourceFileHashes('r2').map((r) => r.filePath).sort();
    expect(r1).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r2).toEqual(['src/c.ts']);
  });

  it('delete removes the row', () => {
    store.setSourceFileHash('r', 'src/a.ts', 'hash-a', '1.0.0');
    store.deleteSourceFileHash('r', 'src/a.ts');
    expect(store.getSourceFileHash('r', 'src/a.ts')).toBeNull();
  });

  it('persists the schema version so incremental can detect drift', () => {
    store.setSourceFileHash('r', 'src/a.ts', 'hash-a', '1.0.0');
    expect(store.getSourceFileHash('r', 'src/a.ts')?.schemaVersion).toBe('1.0.0');
    // Re-write with a new version.
    store.setSourceFileHash('r', 'src/a.ts', 'hash-a', '1.1.0');
    expect(store.getSourceFileHash('r', 'src/a.ts')?.schemaVersion).toBe('1.1.0');
  });
});

// ──────────────────────────────────────────────────────────────────────
// mergeAliasedDatabaseTables (#384)
// ──────────────────────────────────────────────────────────────────────

describe('mergeAliasedDatabaseTables', () => {
  const sys: SchemaNode = {
    nodeType: 'DatabaseSystem',
    id: idFor.databaseSystem({ kind: 'postgres', name: 'typeorm' }),
    kind: 'postgres',
    name: 'typeorm',
    connectionSource: null,
  };
  const canonical = (name: string, declaredIn: string): SchemaNode => ({
    nodeType: 'DatabaseTable',
    id: idFor.databaseTable({ systemId: sys.id, schema: null, name }),
    systemId: sys.id,
    schema: null,
    name,
    kind: 'table',
    declaredIn,
  });
  const inferred = (name: string): SchemaNode => ({
    nodeType: 'DatabaseTable',
    id: idFor.databaseTable({ systemId: sys.id, schema: null, name }),
    systemId: sys.id,
    schema: null,
    name,
    kind: 'table',
    declaredIn: null,
  });
  const file: SchemaNode = {
    nodeType: 'SourceFile',
    id: idFor.sourceFile({ repository: 'r', filePath: 'x.ts' }),
    filePath: 'x.ts',
    repository: 'r',
    language: 'ts',
    framework: null,
  };
  const fn: SchemaNode = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: file.id, name: 'fn', sourceLine: 1 }),
    name: 'fn',
    sourceFileId: file.id,
    sourceLine: 1,
    parameters: [],
    returnType: null,
    isExported: true,
    isAsync: false,
  };

  it('merges PascalCase / camelCase / snake_case singular variants into the canonical', () => {
    const usersC = canonical('users', file.id);
    const userI = inferred('user');
    const UserI = inferred('User');
    store.commit({ nodes: [sys, file, usersC, userI, UserI], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(2);

    const remaining = store.findNodes('DatabaseTable');
    expect(remaining.map((t) => t.name).sort()).toEqual(['users']);
  });

  it('rewires READS edge from inferred to canonical, leaves DBI node intact', () => {
    const usersC = canonical('users', file.id);
    const userI = inferred('user');
    const dbi: SchemaNode = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: fn.id,
        operation: 'read',
        targetTableId: userI.id,
      }),
      callSiteFunctionId: fn.id,
      operation: 'read',
      orm: 'typeorm',
      rawQuery: null,
      confidence: 'inferred',
      evidence: { filePath: 'x.ts', lineStart: 1, lineEnd: 1, snippet: 'find()', confidence: 'exact' },
    };
    const readEdge: SchemaEdge = {
      edgeType: 'READS',
      from: dbi.id,
      to: userI.id,
      columns: null,
      filters: null,
    };
    store.commit({ nodes: [sys, file, fn, usersC, userI, dbi], edges: [readEdge] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(1);
    expect(result.rewrittenEdges).toBeGreaterThanOrEqual(1);

    // DBI node remains; its id is content-hashed on the original
    // targetTableId, so we don't rewrite it. Downstream traversal
    // follows the READS edge, which now points at the canonical id.
    const dbiAfter = store.getNode('DatabaseInteraction', dbi.id);
    expect(dbiAfter).not.toBeNull();

    const reads = store.findEdges(dbi.id, null, 'READS');
    expect(reads).toHaveLength(1);
    expect(reads[0].to).toBe(usersC.id);
  });

  it('does NOT merge when both names are canonical (declaredIn != null)', () => {
    // Both `users` and `user` declared — they refer to different things;
    // never merge.
    const usersC = canonical('users', file.id);
    const userC = canonical('user', 'src/users.entity.ts');
    store.commit({ nodes: [sys, file, usersC, userC], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(0);
    expect(store.findNodes('DatabaseTable')).toHaveLength(2);
  });

  it('handles snake_case canonical → camelCase inferred', () => {
    const appVersionsC = canonical('app_versions', file.id);
    const appVersionI = inferred('appVersion');
    const appVersionsI = inferred('appVersions');
    store.commit({ nodes: [sys, file, appVersionsC, appVersionI, appVersionsI], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(2);

    const remaining = store.findNodes('DatabaseTable');
    expect(remaining.map((t) => t.name).sort()).toEqual(['app_versions']);
  });

  it('is a no-op when no inferred tables exist', () => {
    const c = canonical('users', file.id);
    store.commit({ nodes: [sys, file, c], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(0);
    expect(result.rewrittenEdges).toBe(0);
    expect(store.findNodes('DatabaseTable')).toHaveLength(1);
  });

  // #399 — extended plural handling.

  it('merges -ies/-y plurals (data_queries ↔ dataQuery)', () => {
    const queriesC = canonical('data_queries', file.id);
    const queryI = inferred('dataQuery');
    const queryI2 = inferred('data_query');
    store.commit({ nodes: [sys, file, queriesC, queryI, queryI2], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(2);
    expect(store.findNodes('DatabaseTable').map((t) => t.name).sort()).toEqual(['data_queries']);
  });

  it('merges -es-after-sibilant plurals (addresses ↔ Address)', () => {
    const addressesC = canonical('addresses', file.id);
    const addressI = inferred('address');
    const AddressI = inferred('Address');
    store.commit({ nodes: [sys, file, addressesC, addressI, AddressI], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(2);
    expect(store.findNodes('DatabaseTable').map((t) => t.name).sort()).toEqual(['addresses']);
  });

  it('merges English irregular plurals (people ↔ person)', () => {
    const peopleC = canonical('people', file.id);
    const personI = inferred('person');
    const PersonI = inferred('Person');
    store.commit({ nodes: [sys, file, peopleC, personI, PersonI], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(2);
    expect(store.findNodes('DatabaseTable').map((t) => t.name).sort()).toEqual(['people']);
  });

  it('merges -xes / -ches plurals (boxes ↔ box, batches ↔ batch)', () => {
    const boxesC = canonical('boxes', file.id);
    const boxI = inferred('box');
    const batchesC = canonical('batches', 'src/batch.entity.ts');
    const batchI = inferred('batch');
    store.commit(
      { nodes: [sys, file, boxesC, boxI, batchesC, batchI], edges: [] },
      makeBatchMeta('test'),
    );

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(2);
    const remaining = store.findNodes('DatabaseTable').map((t) => t.name).sort();
    expect(remaining).toEqual(['batches', 'boxes']);
  });

  it('does NOT cross-merge when both names are canonical (people + person both declared)', () => {
    // `people` (irregular plural) and `person` (independent singular)
    // shouldn't collapse if both are explicit canonical entities.
    const peopleC = canonical('people', file.id);
    const personC = canonical('person', 'src/person.entity.ts');
    store.commit({ nodes: [sys, file, peopleC, personC], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(0);
    expect(store.findNodes('DatabaseTable')).toHaveLength(2);
  });

  it('merges data ↔ datum (irregular: `data` is the plural)', () => {
    // `data` is treated as the plural form of `datum` per the
    // IRREGULAR_PLURALS map. Receiver-fallback `datumRepository`
    // emits `datum` which should merge into canonical `data`.
    const dataC = canonical('data', file.id);
    const datumI = inferred('datum');
    store.commit({ nodes: [sys, file, dataC, datumI], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(1);
    expect(store.findNodes('DatabaseTable').map((t) => t.name)).toEqual(['data']);
  });

  it('does not mis-strip short names (length < 4)', () => {
    // `is`, `as`, `bus` are too short to safely process — the
    // generator should not produce nonsense singulars like `i`/`a`/`bu`.
    const isC = canonical('is', file.id);
    const inferredI = inferred('i');
    store.commit({ nodes: [sys, file, isC, inferredI], edges: [] }, makeBatchMeta('test'));

    const result = store.mergeAliasedDatabaseTables();
    expect(result.mergedTables).toBe(0);
    expect(store.findNodes('DatabaseTable')).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// pruneEmptyDatabaseSystems (#385)
// ──────────────────────────────────────────────────────────────────────

describe('pruneEmptyDatabaseSystems', () => {
  it('deletes DatabaseSystem nodes that have no DatabaseTable children', () => {
    const populated: SchemaNode = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'typeorm' }),
      kind: 'postgres',
      name: 'typeorm',
      connectionSource: null,
    };
    const empty1: SchemaNode = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'supabase' }),
      kind: 'postgres',
      name: 'supabase',
      connectionSource: null,
    };
    const empty2: SchemaNode = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'knex' }),
      kind: 'postgres',
      name: 'knex',
      connectionSource: null,
    };
    const tbl: SchemaNode = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: populated.id, schema: null, name: 'users' }),
      systemId: populated.id,
      schema: null,
      name: 'users',
      kind: 'table',
      declaredIn: null,
    };
    store.commit({ nodes: [populated, empty1, empty2, tbl], edges: [] }, makeBatchMeta('test'));

    const result = store.pruneEmptyDatabaseSystems();
    expect(result.deletedSystems).toBe(2);

    const remaining = store.findNodes('DatabaseSystem');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(populated.id);
    expect(store.findNodes('DatabaseTable')).toHaveLength(1);
  });

  it('removes edges referencing the pruned systems', () => {
    const empty: SchemaNode = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'orphan' }),
      kind: 'postgres',
      name: 'orphan',
      connectionSource: null,
    };
    const file: SchemaNode = {
      nodeType: 'SourceFile',
      id: idFor.sourceFile({ repository: 'r', filePath: 'src/x.ts' }),
      filePath: 'src/x.ts',
      repository: 'r',
      language: 'ts',
      framework: null,
    };
    const edge: SchemaEdge = { edgeType: 'DEFINED_IN', from: empty.id, to: file.id };
    store.commit({ nodes: [empty, file], edges: [edge] }, makeBatchMeta('test'));

    const before = store.findEdges(empty.id, null);
    expect(before.length).toBeGreaterThan(0);

    const result = store.pruneEmptyDatabaseSystems();
    expect(result.deletedSystems).toBe(1);
    expect(result.deletedEdges).toBeGreaterThanOrEqual(1);
    expect(store.findEdges(empty.id, null)).toHaveLength(0);
  });

  it('is a no-op when every system has at least one table', () => {
    const sys: SchemaNode = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'main' }),
      kind: 'postgres',
      name: 'main',
      connectionSource: null,
    };
    const tbl: SchemaNode = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: sys.id, schema: null, name: 'users' }),
      systemId: sys.id,
      schema: null,
      name: 'users',
      kind: 'table',
      declaredIn: null,
    };
    store.commit({ nodes: [sys, tbl], edges: [] }, makeBatchMeta('test'));

    const result = store.pruneEmptyDatabaseSystems();
    expect(result.deletedSystems).toBe(0);
    expect(store.findNodes('DatabaseSystem')).toHaveLength(1);
  });

  it('returns zero counts when no DatabaseSystem nodes exist', () => {
    const result = store.pruneEmptyDatabaseSystems();
    expect(result.deletedSystems).toBe(0);
    expect(result.deletedEdges).toBe(0);
  });
});
