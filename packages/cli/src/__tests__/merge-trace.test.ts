import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { makeBatchMeta } from '@veoable/plugin-api';
import { idFor, type FunctionDefinition, type SourceFile } from '@veoable/schema';
import { mergeTraceFiles } from '../merge-trace.js';

let tmpDir: string;
let traceFile: string;
let store: SQLiteCanonicalGraphStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-merge-trace-'));
  traceFile = path.join(tmpDir, 'trace.jsonl');
  store = new SQLiteCanonicalGraphStore(':memory:');

  // Seed a SourceFile + FunctionDefinition so the merger can attribute.
  const repo = 'test-repo';
  const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/Component.tsx' });
  const sourceFile: SourceFile = {
    nodeType: 'SourceFile',
    id: sourceFileId,
    filePath: 'src/Component.tsx',
    repository: repo,
    language: 'ts',
    framework: null,
  };
  const fn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId, name: 'Component', sourceLine: 5 }),
    name: 'Component',
    sourceFileId,
    sourceLine: 5,
    parameters: [],
    returnType: null,
    isExported: true,
    isAsync: false,
  };
  store.commit({ nodes: [sourceFile, fn], edges: [] }, makeBatchMeta('test'));
});

afterEach(() => {
  store.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('mergeTraceFiles', () => {
  it('emits a ClientSideAPICaller (+ MAKES_REQUEST) per fetch trace edge attributed to the enclosing fn', () => {
    fs.writeFileSync(traceFile, JSON.stringify({
      kind: 'fetch',
      callSite: { filePath: path.join(tmpDir, 'src/Component.tsx'), line: 12, column: 8 },
      method: 'POST',
      url: '/api/orders',
      timestamp: 1,
    }) + '\n');

    const result = mergeTraceFiles(store, tmpDir, [traceFile]);
    expect(result.filesLoaded).toBe(1);
    expect(result.edgesObserved).toBe(1);
    expect(result.callersEmitted).toBe(1);
    expect(result.unattributable).toBe(0);

    const callers = store.findNodes('ClientSideAPICaller');
    expect(callers).toHaveLength(1);
    expect(callers[0]!.framework).toBe('trace');
    expect(callers[0]!.urlLiteral).toBe('/api/orders');

    const makes = store.findEdges(null, null, 'MAKES_REQUEST');
    expect(makes).toHaveLength(1);
  });

  it('drops trace edges whose callSite filePath has no matching SourceFile in the graph', () => {
    fs.writeFileSync(traceFile, JSON.stringify({
      kind: 'fetch',
      callSite: { filePath: '/some/external/path.js', line: 1, column: 1 },
      method: 'GET',
      url: '/api/anything',
      timestamp: 1,
    }) + '\n');

    const result = mergeTraceFiles(store, tmpDir, [traceFile]);
    expect(result.unattributable).toBe(1);
    expect(result.callersEmitted).toBe(0);
    expect(store.findNodes('ClientSideAPICaller')).toHaveLength(0);
  });

  it('ignores hook trace edges (not materialized as callers in this slice)', () => {
    fs.writeFileSync(traceFile, JSON.stringify({
      kind: 'hook',
      hookName: 'useMutation',
      callSite: { filePath: path.join(tmpDir, 'src/Component.tsx'), line: 10, column: 1 },
      boundFnName: 'createOrder',
      timestamp: 1,
    }) + '\n');

    const result = mergeTraceFiles(store, tmpDir, [traceFile]);
    expect(result.edgesObserved).toBe(1);
    expect(result.callersEmitted).toBe(0);
    expect(store.findNodes('ClientSideAPICaller')).toHaveLength(0);
  });

  it('dedups identical caller emissions across multiple trace files', () => {
    const edge = JSON.stringify({
      kind: 'fetch',
      callSite: { filePath: path.join(tmpDir, 'src/Component.tsx'), line: 12, column: 8 },
      method: 'POST',
      url: '/api/orders',
      timestamp: 1,
    }) + '\n';
    fs.writeFileSync(traceFile, edge);
    const traceFile2 = path.join(tmpDir, 'trace-2.jsonl');
    fs.writeFileSync(traceFile2, edge);

    const result = mergeTraceFiles(store, tmpDir, [traceFile, traceFile2]);
    expect(result.edgesObserved).toBe(2);
    expect(result.callersEmitted).toBe(1); // dedup
    expect(store.findNodes('ClientSideAPICaller')).toHaveLength(1);
  });

  it('counts malformed lines but doesn\'t throw', () => {
    fs.writeFileSync(traceFile, [
      JSON.stringify({ kind: 'fetch', callSite: null, method: 'GET', url: '/x', timestamp: 1 }),
      '{not json',
      JSON.stringify({ kind: 'fetch', callSite: { filePath: path.join(tmpDir, 'src/Component.tsx'), line: 12, column: 1 }, method: 'POST', url: '/api/orders', timestamp: 2 }),
    ].join('\n'));
    const result = mergeTraceFiles(store, tmpDir, [traceFile]);
    expect(result.malformedLines).toBe(1);
    expect(result.edgesObserved).toBe(2);
    expect(result.callersEmitted).toBe(1); // first edge had no callSite → unattributable
    expect(result.unattributable).toBe(1);
  });

  it('returns zero counts on empty input', () => {
    const result = mergeTraceFiles(store, tmpDir, []);
    expect(result).toEqual({
      filesLoaded: 0,
      missingFiles: [],
      edgesObserved: 0,
      malformedLines: 0,
      callersEmitted: 0,
      unattributable: 0,
    });
  });

  it('reports missing files as missingFiles rather than silently dropping them', () => {
    // Write the good file so we can distinguish "missing" from "empty".
    fs.writeFileSync(traceFile, JSON.stringify({
      kind: 'fetch',
      callSite: null,
      method: 'GET',
      url: '/api/x',
      timestamp: 1,
    }) + '\n');
    const result = mergeTraceFiles(store, tmpDir, ['stale.jsonl', traceFile]);
    expect(result.missingFiles).toEqual(['stale.jsonl']);
    expect(result.filesLoaded).toBe(1);
  });
});
