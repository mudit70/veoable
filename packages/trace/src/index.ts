/**
 * @adorable/trace — runtime instrumentation library (#535).
 *
 * A one-line import in a test bootstrap that monkey-patches a small
 * set of registration / network primitives so observed behaviour is
 * captured as edge records to a JSONL file. `adorable analyze
 * --merge-trace <file>` later merges those edges into the canonical
 * graph as a fallback for the static-analysis gaps the framework
 * plugins can't close.
 *
 * Usage:
 *
 *     // vitest.setup.ts (or playwright.config.ts, jest.setup.ts, etc.)
 *     import { initAdorableTrace } from '@adorable/trace';
 *     initAdorableTrace({ outputFile: '.adorable/trace.jsonl' });
 *
 * No other code changes required. The library writes one JSONL line
 * per observed edge. Schema below.
 *
 * Privacy:
 *   - Request bodies are NEVER captured.
 *   - Headers are NEVER captured.
 *   - The trace file is local; the library does not upload it
 *     anywhere. Suggest gitignoring `.adorable/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Self-locate via `import.meta.url` so the call-site filter
 * recognises this library's own frames regardless of how it was
 * installed: published `node_modules/@adorable/trace/dist`, a
 * monorepo workspace named `adorable`, or a forked checkout named
 * something else entirely. We strip the file's basename to get the
 * containing dist directory, which V8 stack frames will quote
 * verbatim.
 */
const LIBRARY_DIR: string = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return '';
  }
})();

/**
 * Edge shapes that can land in the JSONL. `kind` distinguishes the
 * downstream merging logic — each edge has a distinct provenance
 * tag and merges into the canonical graph differently.
 */
export type TraceEdge =
  | {
      kind: 'fetch';
      /** Source location of the fetch() call site, when V8 can infer it. */
      callSite: SourceLocation | null;
      method: string;
      url: string;
      timestamp: number;
    }
  | {
      kind: 'hook';
      /** Hook name (useMutation / useQuery / useSWR / …). */
      hookName: string;
      /** Source location of the hook call site (best-effort). */
      callSite: SourceLocation | null;
      /** Optional bound identifier (`mutationFn: createOrder` → 'createOrder'). */
      boundFnName: string | null;
      timestamp: number;
    }
  | {
      kind: 'axios';
      callSite: SourceLocation | null;
      method: string;
      url: string;
      timestamp: number;
    };

export interface SourceLocation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number | null;
}

export interface InitOptions {
  /** Absolute path or repo-relative path. Will be created if missing. */
  readonly outputFile: string;
  /**
   * URL-rewrite hook. Lets the caller strip query params with PII
   * before they reach the JSONL.
   */
  readonly rewriteUrl?: (url: string) => string;
  /**
   * Disable the fetch patch (useful when a different network mock is
   * in play). Defaults to true.
   */
  readonly hookFetch?: boolean;
  /**
   * Axios instance to attach a request interceptor to. Pass the
   * imported `axios` (or your project-local instance) explicitly —
   * trying to resolve axios via `globalThis` doesn't work under any
   * realistic ESM/CJS bundler setup. Omit to skip the axios patch.
   */
  readonly axios?: AxiosLike;
}

/**
 * Minimal axios surface this library cares about. Shared between
 * `InitOptions.axios` and the patcher so consumers can pass their
 * real axios instance from their bundler without TypeScript
 * fighting over its sprawling type definitions.
 */
export interface AxiosLike {
  interceptors?: {
    request?: {
      use?: (fn: (config: unknown) => unknown) => number;
      eject?: (id: number) => void;
    };
  };
}

interface InternalState {
  outputFile: string;
  rewriteUrl: (url: string) => string;
  installed: boolean;
}

let state: InternalState | null = null;

/**
 * Install the runtime patches. Idempotent — calling twice in the
 * same process is a no-op. Returns a teardown that uninstalls all
 * patches (test suites can scope the install per-test if they
 * prefer, though the default usage is a one-shot setup-file
 * import).
 */
export function initAdorableTrace(opts: InitOptions): () => void {
  if (state?.installed) return () => undefined;

  const outputFile = path.resolve(opts.outputFile);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  state = {
    outputFile,
    rewriteUrl: opts.rewriteUrl ?? ((u) => u),
    installed: true,
  };

  const teardowns: Array<() => void> = [];
  if (opts.hookFetch !== false) teardowns.push(patchFetch());
  if (opts.axios) teardowns.push(patchAxios(opts.axios));

  return () => {
    for (const t of teardowns) t();
    state = null;
  };
}

/**
 * Append a single JSONL line to the trace file. Public so framework
 * plugins or test helpers can record additional edges that the
 * built-in patches don't capture (e.g., a custom SDK).
 */
export function recordTraceEdge(edge: TraceEdge): void {
  if (!state) return;
  try {
    fs.appendFileSync(state.outputFile, JSON.stringify(edge) + '\n');
  } catch {
    // Trace recording must never throw — a failed write would
    // surface as a test failure unrelated to the assertion the
    // user actually cares about. Silently drop.
  }
}

/**
 * Capture the immediate caller's source location from the V8 stack.
 * Walks past the recordTraceEdge / patch frames to find the first
 * frame in user code. Returns null when the stack is uninformative
 * (e.g., minified bundles, native modules).
 */
export function captureCallSite(skipFrames: number = 1): SourceLocation | null {
  const stack = new Error().stack;
  if (!stack) return null;
  // Stack format (V8):
  //   Error
  //     at functionName (filePath:line:column)
  //     at functionName (filePath:line:column)
  // Skip the leading "Error" line + the requested number of caller
  // frames (the recording site + intermediate patches).
  const lines = stack.split('\n').slice(1);
  for (let i = skipFrames; i < lines.length; i++) {
    const m = lines[i]!.match(/\(([^)]+):(\d+):(\d+)\)\s*$/);
    if (!m) continue;
    const filePath = m[1]!;
    if (filePath.includes('node_modules')) continue;
    // Skip this library's own frames. `LIBRARY_DIR` is computed via
    // import.meta.url at module load so it works under any install
    // layout: `node_modules/@adorable/trace/dist`, a monorepo
    // workspace (regardless of repo-root name), or a forked
    // checkout. The published-install fallback substring check
    // keeps things robust if `import.meta.url` ever fails to resolve.
    if (LIBRARY_DIR && filePath.startsWith(LIBRARY_DIR)) continue;
    if (filePath.includes('@adorable/trace')) continue;
    return {
      filePath,
      line: Number.parseInt(m[2]!, 10),
      column: Number.parseInt(m[3]!, 10),
    };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Patches
// ──────────────────────────────────────────────────────────────────────

function patchFetch(): () => void {
  if (typeof globalThis.fetch !== 'function') return () => undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = state ? state.rewriteUrl(toUrl(input)) : toUrl(input);
      recordTraceEdge({
        kind: 'fetch',
        callSite: captureCallSite(2),
        method,
        url,
        timestamp: Date.now(),
      });
    } catch {
      // Recording errors must not bubble up to fetch callers.
    }
    return original(input, init);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function toUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

/**
 * Best-effort axios patch — patches the global `axios` if it's been
 * required by the time `initAdorableTrace` runs. For codebases that
 * use a per-module axios instance (`axios.create({...})`) the
 * recommended path is to call `recordTraceEdge` directly from a
 * request interceptor configured at the test bootstrap.
 */
function patchAxios(axios: AxiosLike): () => void {
  if (!axios.interceptors?.request?.use) return () => undefined;
  const id = axios.interceptors.request.use((config: unknown) => {
    try {
      const cfg = config as { method?: string; url?: string; baseURL?: string };
      const url = (cfg.baseURL ?? '') + (cfg.url ?? '');
      const rewritten = state ? state.rewriteUrl(url) : url;
      recordTraceEdge({
        kind: 'axios',
        callSite: captureCallSite(2),
        method: (cfg.method ?? 'GET').toUpperCase(),
        url: rewritten,
        timestamp: Date.now(),
      });
    } catch {
      // ignored
    }
    return config;
  });
  return () => {
    if (id !== undefined && axios.interceptors?.request?.eject) {
      axios.interceptors.request.eject(id);
    }
  };
}

// ──────────────────────────────────────────────────────────────────────
// Trace-file reader (used by adorable analyze --merge-trace)
// ──────────────────────────────────────────────────────────────────────

export interface TraceFileLoadResult {
  edges: TraceEdge[];
  malformedLineCount: number;
}

/**
 * Read a trace JSONL produced by initAdorableTrace and return the
 * parsed edges. Lines that fail to parse are counted but otherwise
 * silently dropped — a stale trace file from a prior run that
 * partially overlapped with an interrupted process shouldn't fail
 * the analyze command.
 */
export function loadTraceFile(filePath: string): TraceFileLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { edges: [], malformedLineCount: 0 };
  }
  const edges: TraceEdge[] = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const obj = JSON.parse(line);
      if (isValidTraceEdge(obj)) {
        edges.push(obj);
        continue;
      }
      malformed++;
    } catch {
      malformed++;
    }
  }
  return { edges, malformedLineCount: malformed };
}

/**
 * Per-kind validator. Network-shape edges (`fetch`, `axios`) MUST
 * carry a string `method` + string `url` plus a `callSite` that's
 * either null or a `{filePath, line}` object. The merger trips on
 * `undefined` values downstream, so this is the boundary check.
 */
function isValidTraceEdge(obj: unknown): obj is TraceEdge {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.kind !== 'string') return false;
  if (o.kind === 'fetch' || o.kind === 'axios') {
    if (typeof o.method !== 'string' || typeof o.url !== 'string') return false;
    if (o.callSite !== null && !isValidCallSite(o.callSite)) return false;
    return true;
  }
  if (o.kind === 'hook') {
    if (typeof o.hookName !== 'string') return false;
    if (o.callSite !== null && !isValidCallSite(o.callSite)) return false;
    return true;
  }
  return false;
}

function isValidCallSite(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const cs = v as Record<string, unknown>;
  return typeof cs.filePath === 'string' && typeof cs.line === 'number';
}
