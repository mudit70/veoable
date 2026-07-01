import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { CallsFunctionEdge, FunctionDefinition, SourceFile } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { RustLanguagePlugin } from '../rust-language-plugin.js';
import { resolveRustCrossModCalls } from '../cross-mod-resolver.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/rust/cross-mod');

const REPO = 'cross-mod-fixture';

let store: SQLiteCanonicalGraphStore;

async function extractAndCommit(): Promise<void> {
  const plugin = new RustLanguagePlugin();
  const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });
  // Walk every .rs file under the fixture and commit its batch.
  const files = walkRsFiles(FIXTURE_ROOT);
  for (const abs of files) {
    const rel = path.relative(FIXTURE_ROOT, abs).split(path.sep).join('/');
    const batch: NodeBatch = await plugin.extractFile(handle, rel);
    // Force-stamp the repository to the test repo name so cross-mod
    // resolution sees a consistent grouping; lang-rust's loader uses
    // the basename of rootDir by default and we want to control it.
    const restamped: NodeBatch = {
      nodes: batch.nodes.map((n) =>
        n.nodeType === 'SourceFile' ? { ...n, repository: REPO } : n,
      ),
      edges: batch.edges,
    };
    store.commit(restamped, makeBatchMeta('test-extract'));
  }
}

function walkRsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.rs')) out.push(full);
  }
  return out;
}

function fnNamed(store: SQLiteCanonicalGraphStore, name: string, filePath: string): FunctionDefinition {
  const fns = store.findNodes('FunctionDefinition') as FunctionDefinition[];
  const sourceFiles = store.findNodes('SourceFile') as SourceFile[];
  const sfId = sourceFiles.find((sf) => sf.filePath === filePath)!.id;
  const match = fns.find((f) => f.name === name && f.sourceFileId === sfId);
  if (!match) throw new Error(`no FunctionDefinition '${name}' in ${filePath}`);
  return match;
}

beforeEach(async () => {
  store = new SQLiteCanonicalGraphStore(':memory:');
  await extractAndCommit();
});

afterEach(() => {
  store.close();
});

describe('resolveRustCrossModCalls', () => {
  it('emits CALLS_FUNCTION for `orders::cancel(...)` scoped call from routes.rs', () => {
    const batch = resolveRustCrossModCalls(store, FIXTURE_ROOT);
    const dispatch = fnNamed(store, 'dispatch', 'src/routes.rs');
    const cancel = fnNamed(store, 'cancel', 'src/orders.rs');
    const edge = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === dispatch.id && e.to === cancel.id,
    );
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('direct');
  });

  it('emits CALLS_FUNCTION for use-resolved bare `cancel(...)` call', () => {
    const batch = resolveRustCrossModCalls(store, FIXTURE_ROOT);
    const dispatch = fnNamed(store, 'dispatch', 'src/routes.rs');
    const cancel = fnNamed(store, 'cancel', 'src/orders.rs');
    // Two call sites resolve to the same target (`orders::cancel` and
    // `cancel`). The resolver should emit two separate CALLS_FUNCTION
    // edges, one per call site (different sourceLine).
    const edges = (batch.edges as CallsFunctionEdge[]).filter(
      (e) => e.from === dispatch.id && e.to === cancel.id,
    );
    expect(edges.length).toBeGreaterThanOrEqual(2);
    const lines = edges.map((e) => e.sourceLine);
    expect(new Set(lines).size).toBe(edges.length);
  });

  it('emits CALLS_FUNCTION for `crate::orders::archive(...)` (crate prefix stripped)', () => {
    const batch = resolveRustCrossModCalls(store, FIXTURE_ROOT);
    const dispatch = fnNamed(store, 'dispatch', 'src/routes.rs');
    const archive = fnNamed(store, 'archive', 'src/orders.rs');
    const edge = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === dispatch.id && e.to === archive.id,
    );
    expect(edge).toBeDefined();
  });

  it('does NOT emit an edge for an ambiguous bare `duplicate()` call', () => {
    const batch = resolveRustCrossModCalls(store, FIXTURE_ROOT);
    const dispatch = fnNamed(store, 'dispatch', 'src/routes.rs');
    const ordersDup = fnNamed(store, 'duplicate', 'src/orders.rs');
    const ambigDup = fnNamed(store, 'duplicate', 'src/ambig.rs');
    // The call `duplicate()` (no `use` in scope for either) must
    // resolve to neither — the local `duplicate` shadows in the
    // same-file walk (which extract-source-file handles separately),
    // and the cross-mod resolver has no bare-name fallback.
    const toOrders = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === dispatch.id && e.to === ordersDup.id,
    );
    const toAmbig = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === dispatch.id && e.to === ambigDup.id,
    );
    expect(toOrders).toBeUndefined();
    expect(toAmbig).toBeUndefined();
  });

  it('does NOT emit cross-file edges for same-file calls', () => {
    // The local `duplicate` in routes.rs is called by `dispatch` and
    // already gets a same-file CALLS_FUNCTION from extract-source-file.
    // Our resolver must filter same-file targets so it doesn't
    // duplicate that edge.
    const batch = resolveRustCrossModCalls(store, FIXTURE_ROOT);
    const dispatch = fnNamed(store, 'dispatch', 'src/routes.rs');
    const localDup = fnNamed(store, 'duplicate', 'src/routes.rs');
    const edge = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === dispatch.id && e.to === localDup.id,
    );
    expect(edge).toBeUndefined();
  });

  it('does NOT emit phantom edges from raw strings or nested block comments', () => {
    const batch = resolveRustCrossModCalls(store, FIXTURE_ROOT);
    const rawFn = fnNamed(store, 'raw_and_nested', 'src/routes.rs');
    const cancel = fnNamed(store, 'cancel', 'src/orders.rs');
    const archive = fnNamed(store, 'archive', 'src/orders.rs');
    const ghostCancel = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === rawFn.id && e.to === cancel.id,
    );
    const ghostArchive = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === rawFn.id && e.to === archive.id,
    );
    expect(ghostCancel).toBeUndefined();
    expect(ghostArchive).toBeUndefined();
  });

  it('does NOT attribute an impl method call to a top-level fn of the same name', () => {
    // routes.rs has BOTH a top-level `fn cancel()` and an impl method
    // `Stub::cancel(&self)`. The impl method calls `orders::cancel`.
    // The cross-mod resolver excludes impl bodies entirely from its
    // function-range scan, so no FunctionRange covers the impl call
    // line, and no edge is attributed to the top-level `cancel`.
    const batch = resolveRustCrossModCalls(store, FIXTURE_ROOT);
    const topLevelCancel = fnNamed(store, 'cancel', 'src/routes.rs');
    const ordersCancel = fnNamed(store, 'cancel', 'src/orders.rs');
    const ghost = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === topLevelCancel.id && e.to === ordersCancel.id,
    );
    expect(ghost).toBeUndefined();
  });

  it('does NOT emit phantom edges from doc-comments or string literals', () => {
    // `commented_only` in routes.rs has a `/// Replacement for
    // \`orders::cancel(id)\`` doc comment and a `"orders::archive(id)"`
    // string literal in its body. Neither should produce a
    // CALLS_FUNCTION edge — the masking pass blanks comments and
    // strings before the call-extractor runs.
    const batch = resolveRustCrossModCalls(store, FIXTURE_ROOT);
    const commentedOnly = fnNamed(store, 'commented_only', 'src/routes.rs');
    const cancel = fnNamed(store, 'cancel', 'src/orders.rs');
    const archive = fnNamed(store, 'archive', 'src/orders.rs');
    const ghostCancel = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === commentedOnly.id && e.to === cancel.id,
    );
    const ghostArchive = (batch.edges as CallsFunctionEdge[]).find(
      (e) => e.from === commentedOnly.id && e.to === archive.id,
    );
    expect(ghostCancel).toBeUndefined();
    expect(ghostArchive).toBeUndefined();
  });

  it('returns an empty batch on a project with no Rust files', () => {
    const empty = path.resolve(__dirname); // a directory with no .rs files
    // Use a fresh store with no Rust source files so the gate fires
    // (the default beforeEach store has the fixture's .rs sources).
    const freshStore = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const batch = resolveRustCrossModCalls(freshStore, empty);
      expect(batch.nodes).toEqual([]);
      expect(batch.edges).toEqual([]);
    } finally {
      freshStore.close();
    }
  });
});
