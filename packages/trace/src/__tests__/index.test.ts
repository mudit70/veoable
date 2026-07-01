import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { initAdorableTrace, loadTraceFile, recordTraceEdge } from '../index.js';

let tmpDir: string;
let traceFile: string;
let teardown: () => void = () => undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-trace-test-'));
  traceFile = path.join(tmpDir, 'trace.jsonl');
});

afterEach(() => {
  teardown();
  teardown = () => undefined;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('initAdorableTrace + recordTraceEdge', () => {
  it('writes a JSONL line per recorded edge and reads it back', () => {
    teardown = initAdorableTrace({ outputFile: traceFile });
    recordTraceEdge({
      kind: 'hook',
      hookName: 'useMutation',
      callSite: { filePath: '/proj/Component.tsx', line: 12, column: 5 },
      boundFnName: 'createOrder',
      timestamp: 1234,
    });
    recordTraceEdge({
      kind: 'fetch',
      callSite: { filePath: '/proj/api.ts', line: 30, column: 12 },
      method: 'POST',
      url: '/api/orders',
      timestamp: 5678,
    });
    const result = loadTraceFile(traceFile);
    expect(result.malformedLineCount).toBe(0);
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0]!.kind).toBe('hook');
    expect(result.edges[1]!.kind).toBe('fetch');
  });

  it('is idempotent — calling initAdorableTrace twice does not duplicate teardown', () => {
    teardown = initAdorableTrace({ outputFile: traceFile });
    const noop = initAdorableTrace({ outputFile: traceFile });
    // Second call returns a no-op teardown. Calling it must not
    // crash even though the first installation still owns the
    // global patches.
    expect(() => noop()).not.toThrow();
  });

  it('records fetch calls via the global patch', async () => {
    // Stub the global fetch BEFORE initAdorableTrace so the install
    // patches the stub (not the real network fetch). This mirrors the
    // recommended bootstrap order (mock the network FIRST, then
    // install the trace patches).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    teardown = () => { globalThis.fetch = originalFetch; };
    const innerTeardown = initAdorableTrace({ outputFile: traceFile });
    const prevTeardown = teardown;
    teardown = () => { innerTeardown(); prevTeardown(); };
    await fetch('https://example.test/api/orders', { method: 'POST' });
    const result = loadTraceFile(traceFile);
    const fetches = result.edges.filter((e) => e.kind === 'fetch');
    expect(fetches.length).toBeGreaterThanOrEqual(1);
    const f = fetches[0]!;
    if (f.kind === 'fetch') {
      expect(f.method).toBe('POST');
      expect(f.url).toBe('https://example.test/api/orders');
    }
  });

  it('records axios requests via an explicit axios instance', () => {
    // Construct a minimal AxiosLike with a request interceptor harness.
    // initAdorableTrace attaches our recorder via `.interceptors.request.use`.
    let interceptor: ((cfg: unknown) => unknown) | null = null;
    const fakeAxios = {
      interceptors: {
        request: {
          use: (fn: (cfg: unknown) => unknown) => {
            interceptor = fn;
            return 1;
          },
          eject: (_id: number) => { interceptor = null; },
        },
      },
    };
    teardown = initAdorableTrace({ outputFile: traceFile, axios: fakeAxios });
    expect(interceptor).not.toBeNull();
    // Simulate axios calling its request interceptor before the
    // request hits the wire. Pass a typical Axios request config.
    interceptor!({ method: 'POST', url: '/api/orders', baseURL: 'https://example.test' });

    const result = loadTraceFile(traceFile);
    const axiosEdge = result.edges.find((e) => e.kind === 'axios');
    expect(axiosEdge).toBeDefined();
    if (axiosEdge && axiosEdge.kind === 'axios') {
      expect(axiosEdge.method).toBe('POST');
      expect(axiosEdge.url).toBe('https://example.test/api/orders');
    }
  });

  it('respects rewriteUrl: passes URL through user-supplied rewriter', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    teardown = () => { globalThis.fetch = originalFetch; };
    const innerTeardown = initAdorableTrace({
      outputFile: traceFile,
      rewriteUrl: (u) => u.replace(/\?.*$/, ''),
    });
    const prevTeardown = teardown;
    teardown = () => { innerTeardown(); prevTeardown(); };
    await fetch('https://example.test/api/orders?token=secret');
    const result = loadTraceFile(traceFile);
    const f = result.edges.find((e) => e.kind === 'fetch');
    expect(f).toBeDefined();
    if (f && f.kind === 'fetch') {
      expect(f.url).toBe('https://example.test/api/orders');
    }
  });
});

describe('loadTraceFile', () => {
  it('returns empty edges when the file does not exist', () => {
    const result = loadTraceFile(path.join(tmpDir, 'missing.jsonl'));
    expect(result.edges).toEqual([]);
    expect(result.malformedLineCount).toBe(0);
  });

  it('counts malformed lines without throwing', () => {
    fs.writeFileSync(traceFile, [
      JSON.stringify({ kind: 'fetch', callSite: null, method: 'GET', url: '/a', timestamp: 1 }),
      '{not json',
      '',
      'totally not json either',
      JSON.stringify({ kind: 'hook', hookName: 'useMutation', callSite: null, boundFnName: null, timestamp: 2 }),
    ].join('\n'));
    const result = loadTraceFile(traceFile);
    expect(result.edges).toHaveLength(2);
    expect(result.malformedLineCount).toBe(2);
  });
});
