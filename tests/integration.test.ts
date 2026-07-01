import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idFor, SCHEMA_VERSION } from '@veoable/schema';
import { makeBatchMeta } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { initObservability, resetObservability, withSpan } from '@veoable/observability';

/**
 * Workspace integration smoke test.
 *
 * Asserts that the foundational packages — schema, plugin-api,
 * observability, graph-db — work together end-to-end. Concretely:
 * a plugin-shaped caller can build a `BatchMeta`, emit a tiny batch
 * of canonical nodes and edges through `withSpan` + a confidence
 * decision recording, commit it idempotently to the canonical store,
 * and read it back via `getNode` / `findNodes` / `findEdges`.
 *
 * This replaces the previous integration test which exercised the
 * legacy REST API + MCP server + facade layer (all removed in
 * #67 part 3/3 alongside `packages/core/src/types/*`).
 */

let store: SQLiteCanonicalGraphStore;

beforeEach(async () => {
  await resetObservability();
  initObservability({ exporter: 'none' });
  store = new SQLiteCanonicalGraphStore(':memory:');
});

afterEach(async () => {
  store.close();
  await resetObservability();
});

describe('foundational integration', () => {
  it('a plugin-shaped commit round-trips through every foundational package', async () => {
    const repo = 'veoable';
    const filePath = 'src/users.ts';
    const fileId = idFor.sourceFile({ repository: repo, filePath });
    const fnId = idFor.functionDefinition({ sourceFileId: fileId, name: 'getUser', sourceLine: 10 });

    await withSpan('integration.commit', { 'plugin.id': 'ts' }, async () => {
      const meta = makeBatchMeta('ts');
      expect(meta.schemaVersion).toBe(SCHEMA_VERSION);

      store.commit(
        {
          nodes: [
            {
              nodeType: 'SourceFile',
              id: fileId,
              filePath,
              repository: repo,
              language: 'ts',
              framework: null,
            },
            {
              nodeType: 'FunctionDefinition',
              id: fnId,
              name: 'getUser',
              sourceFileId: fileId,
              sourceLine: 10,
              parameters: [{ name: 'id', type: 'string' }],
              returnType: 'Promise<User>',
              isExported: true,
              isAsync: true,
            },
          ],
          edges: [{ edgeType: 'DEFINED_IN', from: fnId, to: fileId }],
        },
        meta
      );
    });

    // getNode hit
    const file = store.getNode('SourceFile', fileId);
    expect(file?.filePath).toBe(filePath);

    // findNodes filter
    const fns = store.findNodes('FunctionDefinition', { isExported: true });
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('getUser');

    // findEdges traversal
    const edges = store.findEdges(fnId, fileId, 'DEFINED_IN');
    expect(edges).toHaveLength(1);

    // batch attribution
    const batches = store.listBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].producedBy).toBe('ts');
    expect(batches[0].schemaVersion).toBe(SCHEMA_VERSION);
    expect(batches[0].nodeCount).toBe(2);
    expect(batches[0].edgeCount).toBe(1);
  });

  it('committing the same batch twice is idempotent across the full stack', () => {
    const repo = 'veoable';
    const fileId = idFor.sourceFile({ repository: repo, filePath: 'a.ts' });
    const node = {
      nodeType: 'SourceFile' as const,
      id: fileId,
      filePath: 'a.ts',
      repository: repo,
      language: 'ts',
      framework: null,
    };
    const meta = makeBatchMeta('ts');
    store.commit({ nodes: [node], edges: [] }, meta);
    store.commit({ nodes: [node], edges: [] }, meta);
    expect(store.findNodes('SourceFile')).toHaveLength(1);
  });
});
