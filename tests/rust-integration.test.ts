/**
 * Integration test for the Rust language plugin (#149).
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { analyze, type AnalysisResult } from '@adorable/cli';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE_ROOT = path.resolve(__dirname, '../examples/stack-samples/issue-149-rust');

const openStores: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const store of openStores) {
    try { store.close(); } catch {}
  }
  openStores.length = 0;
});

async function analyzeRustApp(): Promise<AnalysisResult> {
  const result = await analyze({ rootDir: SAMPLE_ROOT, stitchMode: 'none' });
  openStores.push(result.store);
  return result;
}

describe('issue-149-rust sample app (full pipeline)', () => {
  it('discovers .rs source files', async () => {
    const result = await analyzeRustApp();
    expect(result.sourceFileCount).toBeGreaterThan(0);
  });

  it('emits SourceFile nodes with language=rust', async () => {
    const result = await analyzeRustApp();
    const sourceFiles = result.store.findNodes('SourceFile');
    const rsFiles = sourceFiles.filter((sf) => sf.language === 'rust');
    expect(rsFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('detects pub functions as exported', async () => {
    const result = await analyzeRustApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const exported = fns.filter((f) => f.isExported);
    const names = exported.map((f) => f.name);
    expect(names).toContain('health_check');
    expect(names).toContain('list_users');
  });

  it('detects impl block methods as Type.method', async () => {
    const result = await analyzeRustApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);
    expect(names).toContain('User.new');
    expect(names).toContain('User.display_name');
    expect(names).toContain('UserService.new');
    expect(names).toContain('UserService.get_all');
    expect(names).toContain('UserService.create');
  });

  it('detects private methods as not exported', async () => {
    const result = await analyzeRustApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const validate = fns.find((f) => f.name === 'User.validate');
    expect(validate).toBeDefined();
    expect(validate!.isExported).toBe(false);
  });

  it('detects trait impl methods (Display for User)', async () => {
    const result = await analyzeRustApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const fmt = fns.find((f) => f.name === 'User.fmt');
    expect(fmt).toBeDefined();
  });

  it('detects async handler functions', async () => {
    const result = await analyzeRustApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const asyncFns = fns.filter((f) => f.isAsync);
    expect(asyncFns.length).toBeGreaterThanOrEqual(2);
    const names = asyncFns.map((f) => f.name);
    expect(names).toContain('health_check');
  });

  it('detects non-exported helper functions', async () => {
    const result = await analyzeRustApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const formatError = fns.find((f) => f.name === 'format_error');
    expect(formatError).toBeDefined();
    expect(formatError!.isExported).toBe(false);
  });
});
