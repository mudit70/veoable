import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@veoable/schema';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { analyze } from '../analyze.js';

/**
 * Tests for #294 Phase 2a — `--incremental` flag on analyze.
 *
 * Uses a tmp-fs single-repo project so we can mutate files between
 * runs and inspect what got re-extracted. The store's
 * `source_file_hashes` sidecar gives us a deterministic way to check
 * which files the run treats as up-to-date.
 */

let tmpRoot: string;
let dbPath: string;
const REPO_NAME = 'inc-test';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-inc-'));
  dbPath = path.join(tmpRoot, 'x.db');
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(tmpRoot, 'src', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(tmpRoot, 'src', 'c.ts'), 'export const c = 3;\n');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function listHashes(): Array<{ filePath: string; hash: string; schemaVersion: string }> {
  const store = new SQLiteCanonicalGraphStore(dbPath);
  try {
    return store.listSourceFileHashes(REPO_NAME).sort((x, y) => x.filePath.localeCompare(y.filePath));
  } finally {
    store.close();
  }
}

function sourceFilePaths(): string[] {
  const store = new SQLiteCanonicalGraphStore(dbPath);
  try {
    return store.findNodes('SourceFile').map((s) => s.filePath).sort();
  } finally {
    store.close();
  }
}

async function run(opts: { incremental?: boolean; clean?: boolean; onProgress?: (m: string) => void }): Promise<void> {
  await analyze({
    rootDir: tmpRoot,
    dbPath,
    repoName: REPO_NAME,
    clean: opts.clean,
    incremental: opts.incremental,
    onProgress: opts.onProgress,
  });
}

describe('analyze --incremental (#294 Phase 2a)', () => {
  it('first cold run records a hash for every extracted file', async () => {
    await run({ incremental: true });
    const hashes = listHashes();
    expect(hashes.map((h) => h.filePath)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    for (const h of hashes) {
      expect(h.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(h.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });

  it('a second run with no changes does NOT re-extract any file', async () => {
    await run({ incremental: true });
    const hashesBefore = listHashes();
    const pathsBefore = sourceFilePaths();

    // Capture file mtimes via the updated_at column to confirm the
    // rows weren't rewritten on the second pass.
    const store = new SQLiteCanonicalGraphStore(dbPath);
    const rowsBefore = (store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare("SELECT file_path, updated_at FROM source_file_hashes WHERE repository = ?")
      .all(REPO_NAME) as Array<{ file_path: string; updated_at: string }>;
    store.close();

    await new Promise((r) => setTimeout(r, 1100)); // datetime('now') is second-precision
    await run({ incremental: true });

    expect(listHashes()).toEqual(hashesBefore);
    expect(sourceFilePaths()).toEqual(pathsBefore);

    const store2 = new SQLiteCanonicalGraphStore(dbPath);
    const rowsAfter = (store2 as unknown as { db: import('better-sqlite3').Database }).db
      .prepare("SELECT file_path, updated_at FROM source_file_hashes WHERE repository = ?")
      .all(REPO_NAME) as Array<{ file_path: string; updated_at: string }>;
    store2.close();
    // updated_at column is unchanged → row wasn't rewritten.
    expect(rowsAfter.sort()).toEqual(rowsBefore.sort());
  });

  it('mutating one file re-extracts only that file', async () => {
    await run({ incremental: true });
    const hashesBefore = listHashes();
    const oldA = hashesBefore.find((h) => h.filePath === 'src/a.ts')!.hash;

    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), 'export const a = 999;\n');
    await run({ incremental: true });

    const hashesAfter = listHashes();
    const newA = hashesAfter.find((h) => h.filePath === 'src/a.ts')!.hash;
    const newB = hashesAfter.find((h) => h.filePath === 'src/b.ts')!.hash;
    const oldB = hashesBefore.find((h) => h.filePath === 'src/b.ts')!.hash;

    expect(newA).not.toBe(oldA); // a's hash updated
    expect(newB).toBe(oldB);     // b's hash unchanged
    // All three files still present.
    expect(sourceFilePaths()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('removing a file from disk drops its nodes + hash row', async () => {
    await run({ incremental: true });
    fs.unlinkSync(path.join(tmpRoot, 'src', 'c.ts'));
    await run({ incremental: true });
    expect(sourceFilePaths()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(listHashes().map((h) => h.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('adding a new file extracts it and records its hash', async () => {
    await run({ incremental: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'd.ts'), 'export const d = 4;\n');
    await run({ incremental: true });
    expect(sourceFilePaths()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    expect(listHashes().map((h) => h.filePath)).toEqual([
      'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts',
    ]);
  });

  it('falls back to full re-analyze when stored schema version differs', async () => {
    await run({ incremental: true });
    // Forge a stale schema_version on every row.
    const store = new SQLiteCanonicalGraphStore(dbPath);
    (store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare("UPDATE source_file_hashes SET schema_version = 'ancient-0.0.0' WHERE repository = ?")
      .run(REPO_NAME);
    store.close();

    await run({ incremental: true });
    // After fallback: hashes re-written with current SCHEMA_VERSION.
    const hashes = listHashes();
    expect(hashes.length).toBe(3);
    for (const h of hashes) expect(h.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('re-extracts direct importers of a changed file (1-hop reverse-import)', async () => {
    // Fresh fixture: b.ts imports from a.ts; c.ts is unrelated.
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), 'export function pingA(): string { return "v1"; }\n');
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'b.ts'),
      'import { pingA } from "./a.js";\nexport function pingB(): string { return pingA(); }\n',
    );
    fs.writeFileSync(path.join(tmpRoot, 'src', 'c.ts'), 'export const c = 42;\n');

    await run({ incremental: true, clean: true });
    const beforeHashes = listHashes();
    const oldB = beforeHashes.find((h) => h.filePath === 'src/b.ts')!.hash;
    const oldC = beforeHashes.find((h) => h.filePath === 'src/c.ts')!.hash;

    // Mutate a.ts (the imported file). b.ts is unchanged on disk
    // but its IMPORTS-edge target's node was just deleted, so the
    // visitor must re-walk b.ts too. c.ts has no import edge to a
    // and must be left alone.
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), 'export function pingA(): string { return "v2"; }\n');
    await run({ incremental: true });

    const afterHashes = listHashes();
    expect(afterHashes.find((h) => h.filePath === 'src/b.ts')!.hash).toBe(oldB);
    expect(afterHashes.find((h) => h.filePath === 'src/c.ts')!.hash).toBe(oldC);

    // Crucially, b.ts MUST still be present in the graph after the
    // incremental run — its node would have been deleted (then
    // re-created) by the importer-cascade.
    const paths = sourceFilePaths();
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('src/c.ts');

    // Stronger assertion: confirm the IMPORTS edge from b.ts -> a.ts
    // was REBUILT by re-extraction, not just left dangling at a stale
    // target id. Without the reverse-import cascade, deleteByFile(a)
    // would have orphaned the edge.
    const { idFor } = await import('@veoable/schema');
    const bSfId = idFor.sourceFile({ repository: REPO_NAME, filePath: 'src/b.ts' });
    const aSfId = idFor.sourceFile({ repository: REPO_NAME, filePath: 'src/a.ts' });
    const store = new SQLiteCanonicalGraphStore(dbPath);
    try {
      const importsEdges = store.findEdges(bSfId, aSfId, 'IMPORTS');
      expect(importsEdges.length).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });

  it('falls back to full re-extract when the importer cascade exceeds the cap (#420)', async () => {
    // Fixture: a.ts is the hot file. b.ts, c.ts, d.ts all import it.
    // Editing a.ts cascades to 3 importers; cap of 1 should trigger
    // the bail-out and full re-extract.
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), 'export function hot(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'b.ts'),
      'import { hot } from "./a.js";\nexport const b = hot();\n',
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'c.ts'),
      'import { hot } from "./a.js";\nexport const c = hot();\n',
    );
    // d.ts via a fresh discoverable file (replace existing c.ts content
    // so we have a 4-file fixture: a, b, c, d). Use writeFileSync to
    // add d.ts.
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'd.ts'),
      'import { hot } from "./a.js";\nexport const d = hot();\n',
    );

    await run({ incremental: true, clean: true });
    expect(listHashes().length).toBe(4);

    // Edit the hot file. Cascade would invalidate b.ts, c.ts, d.ts
    // (3 importers). With a count cap of 1, the bail-out fires.
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), 'export function hot(): number { return 2; }\n');

    const progress: string[] = [];
    const old = process.env.ADORABLE_MAX_CASCADE_FILES;
    process.env.ADORABLE_MAX_CASCADE_FILES = '1';
    try {
      await run({ incremental: true, onProgress: (m) => progress.push(m) });
    } finally {
      if (old === undefined) delete process.env.ADORABLE_MAX_CASCADE_FILES;
      else process.env.ADORABLE_MAX_CASCADE_FILES = old;
    }

    // The fallback log line must fire and the per-file "incremental:
    // N changed" line must NOT (they're mutually exclusive in the
    // implementation).
    const allLogs = progress.join('\n');
    expect(allLogs).toMatch(/cascade fan-out .*exceeds cap.*full re-extract/);
    expect(allLogs).not.toMatch(/incremental: \d+ changed\/new/);

    // Graph is coherent: all 4 SourceFiles + hashes still present
    // (hashes get rewritten by the full extract).
    expect(sourceFilePaths()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    expect(listHashes().length).toBe(4);
  });

  it('clean wins over incremental: drops the hash cache and re-extracts everything', async () => {
    await run({ incremental: true });
    expect(listHashes().length).toBe(3);

    // Force a re-build via clean. Hash cache should be purged AND
    // repopulated by the same call since incremental is also on.
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), 'export const a = 1234;\n');
    await run({ incremental: true, clean: true });

    expect(sourceFilePaths()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(listHashes().length).toBe(3);
  });
});
