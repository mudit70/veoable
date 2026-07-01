/**
 * Integration tests for non-web client process detection (#62).
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { analyze, type AnalysisResult } from '@adorable/cli';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_ROOT = path.resolve(__dirname, '../examples/stack-samples');

const openStores: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const store of openStores) { try { store.close(); } catch {} }
  openStores.length = 0;
});

async function analyzeApp(dir: string): Promise<AnalysisResult> {
  const result = await analyze({ rootDir: path.join(SAMPLES_ROOT, dir), stitchMode: 'none' });
  openStores.push(result.store);
  return result;
}

describe('issue-62-python-cli sample app', () => {
  it('detects pycli plugin', async () => {
    const result = await analyzeApp('issue-62-python-cli');
    expect(result.detectedPlugins).toContain('pycli');
  });

  it('finds Click CLI command processes', async () => {
    const result = await analyzeApp('issue-62-python-cli');
    const processes = result.store.findNodes('ClientSideProcess');
    const cmds = processes.filter((p) => p.kind === 'cli_command');
    expect(cmds.length).toBeGreaterThanOrEqual(3);
    const names = cmds.map((p) => p.name);
    expect(names).toContain('list_users');
    expect(names).toContain('get_user');
    expect(names).toContain('create_user');
  });

  it('finds script entry point', async () => {
    const result = await analyzeApp('issue-62-python-cli');
    const processes = result.store.findNodes('ClientSideProcess');
    const entries = processes.filter((p) => p.kind === 'script_entry');
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('issue-62-go-cli sample app', () => {
  it('detects gocli plugin', async () => {
    const result = await analyzeApp('issue-62-go-cli');
    expect(result.detectedPlugins).toContain('gocli');
  });

  it('finds Cobra CLI command processes', async () => {
    const result = await analyzeApp('issue-62-go-cli');
    const processes = result.store.findNodes('ClientSideProcess');
    const cmds = processes.filter((p) => p.kind === 'cli_command');
    expect(cmds.length).toBeGreaterThanOrEqual(3);
  });

  it('finds main() entry point', async () => {
    const result = await analyzeApp('issue-62-go-cli');
    const processes = result.store.findNodes('ClientSideProcess');
    const entries = processes.filter((p) => p.kind === 'script_entry');
    expect(entries.length).toBe(1);
  });
});

describe('issue-62-rust-cli sample app', () => {
  it('detects rustcli plugin', async () => {
    const result = await analyzeApp('issue-62-rust-cli');
    expect(result.detectedPlugins).toContain('rustcli');
  });

  it('finds main() entry point', async () => {
    const result = await analyzeApp('issue-62-rust-cli');
    const processes = result.store.findNodes('ClientSideProcess');
    const entries = processes.filter((p) => p.kind === 'script_entry');
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('main');
  });
});
