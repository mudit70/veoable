import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { idFor, type ClientSideProcess, type FunctionDefinition, type SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { TokioSpawnPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/tokio-spawn/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new TokioSpawnPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(plugin.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const processes = (b: { nodes: SchemaNode[] }): ClientSideProcess[] =>
  b.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');

describe('framework-tokio-spawn visitor (#538)', () => {
  it('emits one ClientSideProcess per tokio::spawn(...) call', async () => {
    const batch = await extract('src/main.rs');
    const ps = processes(batch);
    // Positive sites in the fixture:
    //   one_spawn:        1
    //   two_spawns:       2 (distinct sites, different lines)
    //   task_module_spawn: 1 (tokio::task::spawn)
    // Total = 4. Negatives (spawn_blocking, other.spawn, spawn_local)
    // must NOT contribute.
    expect(ps.length).toBe(4);
  });

  it('rejects tokio::spawn_blocking (different semantics, blocking pool)', async () => {
    const batch = await extract('src/main.rs');
    const ps = processes(batch);
    // None of the emitted processes should come from negative_spawn_blocking.
    // We check by line range — that function lives near the end of the fixture.
    // Simpler check: all emitted processes have name === 'tokio::spawn'.
    for (const p of ps) expect(p.name).toBe('tokio::spawn');
    // And we expect exactly 4 — confirming spawn_blocking didn't sneak in.
    expect(ps.length).toBe(4);
  });

  it('rejects non-tokio receivers (Other.spawn, etc.)', async () => {
    // Pinned via the count assertion above. If `other.spawn()` had
    // been lifted, we'd have 5 processes, not 4.
    const batch = await extract('src/main.rs');
    expect(processes(batch).length).toBe(4);
  });

  it('rejects sibling tokio methods like tokio::spawn_local', async () => {
    // Same: covered by the count pin. spawn_local would push us to 5.
    const batch = await extract('src/main.rs');
    expect(processes(batch).length).toBe(4);
  });

  it('marks every process with kind=other + framework=tokio-spawn', async () => {
    const batch = await extract('src/main.rs');
    const ps = processes(batch);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(p.kind).toBe('other');
      expect(p.framework).toBe('tokio-spawn');
      expect(p.name).toBe('tokio::spawn');
    }
  });

  it('produces distinct processes for two spawns in the same function', async () => {
    const batch = await extract('src/main.rs');
    const ids = new Set(processes(batch).map((p) => p.id));
    // 4 spawns → 4 unique ids. The two_spawns function contributes two
    // sites at different lines; id is keyed by (sourceFileId, line, name).
    expect(ids.size).toBe(4);
  });

  it('attributes each process to its enclosing function', async () => {
    const batch = await extract('src/main.rs');
    const ps = processes(batch);
    // Every emitted process must have a functionId — top-level
    // tokio::spawn calls (no enclosing fn) are skipped by design.
    for (const p of ps) expect(p.functionId).toBeTruthy();
    // The fixture has 4 distinct enclosing functions for the 4 spawn sites
    // (one_spawn, two_spawns x2, task_module_spawn). 3 unique functionIds.
    const uniqueFns = new Set(ps.map((p) => p.functionId));
    expect(uniqueFns.size).toBe(3);
  });

  it('resolves the process.functionId to the real FunctionDefinition of its enclosing fn', async () => {
    // Stronger pin than the truthy check above: the functionId field
    // must equal the FunctionDefinition.id that lang-rust emits for
    // the enclosing function. If those drift, the BFS that walks
    // process -> reachable callers breaks silently.
    const batch = await extract('src/main.rs');
    const fns = batch.nodes.filter(
      (n): n is FunctionDefinition => n.nodeType === 'FunctionDefinition',
    );
    const fnByName = new Map(fns.map((f) => [f.name, f.id] as const));
    const oneSpawnFnId = fnByName.get('one_spawn');
    expect(oneSpawnFnId, 'lang-rust should emit a FunctionDefinition named one_spawn').toBeTruthy();

    const ps = processes(batch);
    // Find the process emitted from inside one_spawn (line 21 in the
    // fixture — pinned via `sourceLine` rather than name since all
    // four processes share name='tokio::spawn').
    const inOneSpawn = ps.find((p) => p.sourceLine === 21);
    expect(inOneSpawn, 'a tokio::spawn at line 21 should emit a process').toBeTruthy();
    expect(inOneSpawn!.functionId).toBe(oneSpawnFnId);
  });
});

describe('framework-tokio-spawn plugin activation', () => {
  function ctxWith({ files, deps }: { files: string[]; deps: Record<string, string> }) {
    return {
      rootDir: FIXTURE_ROOT,
      repository: 'fixture',
      files,
      packageJson: null,
      rustManifests: [{ relPath: 'Cargo.toml', dependencies: deps }],
    } as any;
  }

  it('appliesTo() returns true when tokio is declared in Cargo.toml', () => {
    const plugin = new TokioSpawnPlugin();
    expect(plugin.appliesTo(ctxWith({ files: ['src/main.rs'], deps: { tokio: '1' } }))).toBe(true);
  });

  it('appliesTo() returns false when tokio is not declared', () => {
    const plugin = new TokioSpawnPlugin();
    expect(plugin.appliesTo(ctxWith({ files: ['src/main.rs'], deps: { serde: '1' } }))).toBe(false);
  });

  it('appliesTo() returns false on a non-Rust project', () => {
    const plugin = new TokioSpawnPlugin();
    expect(plugin.appliesTo(ctxWith({ files: ['src/main.ts'], deps: { tokio: '1' } }))).toBe(false);
  });
});
