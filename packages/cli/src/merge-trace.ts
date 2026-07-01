import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  idFor,
  type ClientSideAPICaller,
  type FunctionDefinition,
  type SchemaEdge,
  type SourceFile,
} from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import type { CanonicalGraphStore } from '@adorable/graph-db';
import { loadTraceFile, type TraceEdge } from '@adorable/trace';

/**
 * Trace-merge pass (#535). Read one or more JSONL trace files
 * produced by `@adorable/trace`, materialize the runtime-observed
 * edges as canonical-graph nodes/edges, and commit them as a
 * fallback for static-analysis misses (#531's residue).
 *
 * Provenance marker: emitted callers carry `framework: 'trace'` and
 * the trace edge's URL goes in `urlLiteral` (read by the existing
 * flow stitcher to match against `APIEndpoint.routePattern`). The
 * caller's evidence snippet records "runtime trace" so MCP queries
 * surfaces the provenance without needing a schema change.
 *
 * Attribution policy: a trace edge's `callSite.filePath` is used to
 * find the SourceFile in the store; the function whose start line
 * is closest to the trace site (and ≤ it) becomes the
 * `functionId`. If no SourceFile matches (rare — typically a file
 * outside the analyzed root), the edge is dropped with a counter
 * increment so the caller-side counts stay accurate.
 *
 * Returns merge statistics for the CLI summary.
 */
export interface TraceMergeResult {
  /** Number of trace files actually read. */
  readonly filesLoaded: number;
  /** Number of explicit `--merge-trace` paths whose file was missing
   *  (does not exist or is unreadable). The merger never throws, so
   *  the caller surfaces this as a stderr warning.
   */
  readonly missingFiles: ReadonlyArray<string>;
  /** Total number of JSONL lines parsed across all files. */
  readonly edgesObserved: number;
  /** Number of malformed lines (silently dropped). */
  readonly malformedLines: number;
  /** Edges materialized as canonical callers + MAKES_REQUEST. */
  readonly callersEmitted: number;
  /** Edges dropped because no SourceFile match was found. */
  readonly unattributable: number;
}

export function mergeTraceFiles(
  store: CanonicalGraphStore,
  rootDir: string,
  tracePaths: ReadonlyArray<string>,
): TraceMergeResult {
  if (tracePaths.length === 0) {
    return { filesLoaded: 0, missingFiles: [], edgesObserved: 0, malformedLines: 0, callersEmitted: 0, unattributable: 0 };
  }

  const allEdges: TraceEdge[] = [];
  const missingFiles: string[] = [];
  let malformed = 0;
  let filesLoaded = 0;
  for (const raw of tracePaths) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
    // Check existence explicitly so the caller can surface a stderr
    // warning when a `--merge-trace` flag points at a stale path.
    // loadTraceFile silently returns `{edges:[], malformedLineCount:0}`
    // for missing files, which we otherwise can't distinguish from a
    // file that exists but is empty.
    let exists = false;
    try {
      exists = fs.statSync(abs).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      missingFiles.push(raw);
      continue;
    }
    const result = loadTraceFile(abs);
    filesLoaded++;
    allEdges.push(...result.edges);
    malformed += result.malformedLineCount;
  }

  // Index FunctionDefinitions per SourceFile so attribution is O(F)
  // per source file instead of O(F·T).
  const sourceFiles = store.findNodes('SourceFile') as SourceFile[];
  const sfByAbsPath = new Map<string, SourceFile>();
  const sfByPosixPath = new Map<string, SourceFile>();
  for (const sf of sourceFiles) {
    sfByPosixPath.set(sf.filePath, sf);
    sfByAbsPath.set(path.resolve(rootDir, sf.filePath), sf);
  }
  const fnsBySfId = new Map<string, FunctionDefinition[]>();
  for (const fn of store.findNodes('FunctionDefinition') as FunctionDefinition[]) {
    const list = fnsBySfId.get(fn.sourceFileId);
    if (list) list.push(fn);
    else fnsBySfId.set(fn.sourceFileId, [fn]);
  }

  const batch: NodeBatch = { nodes: [], edges: [] };
  let callersEmitted = 0;
  let unattributable = 0;
  const seenCallerId = new Set<string>();

  for (const edge of allEdges) {
    const networkEdge = toNetworkShape(edge);
    if (!networkEdge) continue; // hook-only edges aren't materialized as callers
    const sf = resolveSourceFile(networkEdge.callSite?.filePath ?? null, sfByAbsPath, sfByPosixPath, rootDir);
    if (!sf) { unattributable++; continue; }
    const fn = pickEnclosingFn(fnsBySfId.get(sf.id) ?? [], networkEdge.callSite?.line ?? 0);
    if (!fn) { unattributable++; continue; }

    const caller = buildCaller(sf, fn, networkEdge);
    if (seenCallerId.has(caller.id)) continue;
    seenCallerId.add(caller.id);
    batch.nodes.push(caller);
    batch.edges.push({
      edgeType: 'MAKES_REQUEST',
      from: fn.id,
      to: caller.id,
    } as SchemaEdge);
    callersEmitted++;
  }

  if (batch.nodes.length > 0 || batch.edges.length > 0) {
    store.commit(batch, makeBatchMeta('adorable.trace.merge'));
  }

  return {
    filesLoaded,
    missingFiles,
    edgesObserved: allEdges.length,
    malformedLines: malformed,
    callersEmitted,
    unattributable,
  };
}

interface NetworkLikeEdge {
  readonly method: string;
  readonly url: string;
  readonly callSite: { filePath: string; line: number; column: number | null } | null;
}

function toNetworkShape(edge: TraceEdge): NetworkLikeEdge | null {
  if (edge.kind === 'fetch' || edge.kind === 'axios') {
    return { method: edge.method, url: edge.url, callSite: edge.callSite };
  }
  // 'hook' edges record a registration, not a network call. They are
  // useful future inputs for cross-file CALLS_FUNCTION fallback but
  // not turned into ClientSideAPICallers here.
  return null;
}

function resolveSourceFile(
  rawPath: string | null,
  sfByAbsPath: ReadonlyMap<string, SourceFile>,
  sfByPosixPath: ReadonlyMap<string, SourceFile>,
  rootDir: string,
): SourceFile | null {
  if (!rawPath) return null;
  // V8 stacks emit absolute paths; SourceFile.filePath is repo-relative
  // POSIX. Try the absolute index first, then fall back to deriving a
  // relative path.
  const absHit = sfByAbsPath.get(rawPath);
  if (absHit) return absHit;
  if (rawPath.startsWith(rootDir + path.sep) || rawPath.startsWith(rootDir + '/')) {
    const rel = rawPath.slice(rootDir.length + 1).split(path.sep).join('/');
    const hit = sfByPosixPath.get(rel);
    if (hit) return hit;
  }
  return null;
}

function pickEnclosingFn(fns: ReadonlyArray<FunctionDefinition>, callLine: number): FunctionDefinition | null {
  if (fns.length === 0) return null;
  // Known imprecision: innermost containment isn't computable from
  // sourceLine alone (FunctionDefinition has no endLine). We pick the
  // function whose sourceLine is the closest one ≤ the call line —
  // the function whose body STARTS last before the call site. This
  // mis-attributes a module-scope call between functions to the
  // last preceding fn rather than reporting no enclosing fn. The
  // dedup edge ids absorb the duplication when the same URL fires
  // multiple times from the same line, but a follow-up that adds
  // FunctionDefinition.endLine would let us be precise.
  let best: FunctionDefinition | null = null;
  for (const fn of fns) {
    if (fn.sourceLine > callLine) continue;
    if (!best || fn.sourceLine > best.sourceLine) best = fn;
  }
  return best;
}

function buildCaller(
  sf: SourceFile,
  fn: FunctionDefinition,
  edge: NetworkLikeEdge,
): ClientSideAPICaller {
  const sourceLine = edge.callSite?.line ?? fn.sourceLine;
  return {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: sf.id,
      sourceLine,
      urlLiteral: edge.url,
    }),
    functionId: fn.id,
    sourceFileId: sf.id,
    sourceLine,
    httpMethod: edge.method,
    urlLiteral: edge.url,
    // `pattern` because the URL is a runtime-observed instance (which
    // may include path parameters), and the static stitcher will
    // pattern-match against APIEndpoint.routePattern.
    egressConfidence: 'pattern',
    framework: 'trace',
    repository: sf.repository,
    evidence: {
      filePath: sf.filePath,
      lineStart: sourceLine,
      lineEnd: sourceLine,
      snippet: `runtime trace: ${edge.method} ${edge.url}`,
      confidence: 'inferred',
    },
  } satisfies ClientSideAPICaller as ClientSideAPICaller;
}

