import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsLanguagePlugin } from '../ts-language-plugin.js';
import { unwrapHandle } from '../project-handle.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/callgraph/ts/imports');

/**
 * Tests for #253 — bounded LRU window in TsLanguagePlugin.
 *
 * The env var `ADORABLE_LANG_TS_MAX_PARSED_FILES` opts into a fixed
 * cap on the number of SourceFile ASTs kept in the ts-morph Project.
 * When unset (default), the plugin is unchanged — legacy behavior.
 *
 * The risk of enabling LRU is that cross-file resolution may regress
 * because chasing symbols into a forgotten file fails. We test:
 *   1. Default (env var unset): legacy behavior — no files are forgotten.
 *   2. Opt-in (limit=2): older extracted files are forgotten.
 *   3. Opt-in: every extracted file's nodes/edges still emit correctly
 *      at the moment of extraction.
 */

const ENV_KEY = 'ADORABLE_LANG_TS_MAX_PARSED_FILES';
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env[ENV_KEY];
});

afterEach(() => {
  if (prevEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = prevEnv;
  }
});

describe('LRU eviction (#253)', () => {
  it('default behavior: no env var → no files are forgotten', async () => {
    delete process.env[ENV_KEY];
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });
    const internal = unwrapHandle(handle);

    await plugin.extractFile(handle, 'src/index.ts');
    await plugin.extractFile(handle, 'src/named.ts');

    // Both files still have a live SourceFile entry.
    expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/index.ts'))).not.toBeUndefined();
    expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/named.ts'))).not.toBeUndefined();
  });

  it('limit=1 evicts the previous file after a new extraction', async () => {
    process.env[ENV_KEY] = '1';
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });
    const internal = unwrapHandle(handle);

    await plugin.extractFile(handle, 'src/named.ts');
    // utils.ts is in the window.
    expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/named.ts'))).not.toBeUndefined();

    await plugin.extractFile(handle, 'src/index.ts');
    // utils.ts evicted; index.ts in the window.
    expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/named.ts'))).toBeUndefined();
    expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/index.ts'))).not.toBeUndefined();
  });

  it('limit=2 keeps the two most recent files; older ones evicted', async () => {
    process.env[ENV_KEY] = '2';
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });
    const internal = unwrapHandle(handle);

    await plugin.extractFile(handle, 'src/named.ts');
    await plugin.extractFile(handle, 'src/index.ts');
    // Both still in the window.
    expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/named.ts'))).not.toBeUndefined();
    expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/index.ts'))).not.toBeUndefined();
  });

  it('re-extracting the same file refreshes its LRU position', async () => {
    process.env[ENV_KEY] = '1';
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });
    const internal = unwrapHandle(handle);

    await plugin.extractFile(handle, 'src/named.ts');
    await plugin.extractFile(handle, 'src/named.ts');
    // Same file re-extracted; still present.
    expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/named.ts'))).not.toBeUndefined();
  });

  it('emits the expected NodeBatch shape even when LRU is active', async () => {
    process.env[ENV_KEY] = '1';
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });

    const batch = await plugin.extractFile(handle, 'src/index.ts');
    expect(Array.isArray(batch.nodes)).toBe(true);
    expect(Array.isArray(batch.edges)).toBe(true);
    expect(batch.nodes.length).toBeGreaterThan(0);
  });

  it('re-extracting a forgotten file throws — orchestrator must not revisit', async () => {
    // Defensive pin per reviewer of #413: documents the orchestrator
    // contract under LRU. The current cli/src/analyze.ts extracts each
    // file exactly once, so this throw is never hit in practice — but
    // if a future orchestrator change revisits a forgotten file, the
    // failure mode is loud and obvious rather than silent.
    process.env[ENV_KEY] = '1';
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });

    await plugin.extractFile(handle, 'src/named.ts');
    await plugin.extractFile(handle, 'src/index.ts');
    // named.ts has been forgotten; re-extracting it must throw with
    // the same "file not loaded" error the legacy path uses for
    // genuinely-missing files.
    await expect(plugin.extractFile(handle, 'src/named.ts')).rejects.toThrow(
      /extractFile called for .* but the file was not loaded/,
    );
  });

  it('ignores invalid env values (negative, zero, non-numeric) — defaults to legacy', async () => {
    for (const bad of ['-5', '0', 'abc', '']) {
      process.env[ENV_KEY] = bad;
      const plugin = new TsLanguagePlugin();
      const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });
      const internal = unwrapHandle(handle);

      await plugin.extractFile(handle, 'src/named.ts');
      await plugin.extractFile(handle, 'src/index.ts');
      // Legacy behavior — both files retained.
      expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/named.ts'))).not.toBeUndefined();
      expect(internal.project.getSourceFile(path.join(FIXTURE_ROOT, 'src/index.ts'))).not.toBeUndefined();
    }
  });
});
