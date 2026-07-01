/**
 * Integration test for the PHP language plugin (#145).
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { analyze, type AnalysisResult } from '@adorable/cli';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE_ROOT = path.resolve(__dirname, '../examples/stack-samples/issue-145-php');

const openStores: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const store of openStores) {
    try { store.close(); } catch { /* already closed */ }
  }
  openStores.length = 0;
});

async function analyzePhpApp(): Promise<AnalysisResult> {
  const result = await analyze({ rootDir: SAMPLE_ROOT, stitchMode: 'none' });
  openStores.push(result.store);
  return result;
}

describe('issue-145-php sample app (full pipeline)', () => {
  it('discovers .php source files', async () => {
    const result = await analyzePhpApp();
    expect(result.sourceFileCount).toBeGreaterThan(0);
  });

  it('emits SourceFile nodes with language=php', async () => {
    const result = await analyzePhpApp();
    const sourceFiles = result.store.findNodes('SourceFile');
    const phpFiles = sourceFiles.filter((sf) => sf.language === 'php');
    expect(phpFiles.length).toBeGreaterThanOrEqual(3);
  });

  it('detects public controller methods', async () => {
    const result = await analyzePhpApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);
    expect(names).toContain('UserController.index');
    expect(names).toContain('UserController.show');
    expect(names).toContain('UserController.store');
    expect(names).toContain('UserController.destroy');
  });

  it('detects service methods', async () => {
    const result = await analyzePhpApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);
    expect(names).toContain('UserService.getAllUsers');
    expect(names).toContain('UserService.createUser');
  });

  it('detects private methods as not exported', async () => {
    const result = await analyzePhpApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const validate = fns.find((f) => f.name === 'UserService.validateUser');
    expect(validate).toBeDefined();
    expect(validate!.isExported).toBe(false);
  });

  it('detects model class methods', async () => {
    const result = await analyzePhpApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);
    expect(names).toContain('User.getName');
    expect(names).toContain('User.getEmail');
  });

  it('detects constructors', async () => {
    const result = await analyzePhpApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const ctors = fns.filter((f) => f.name.endsWith('.constructor'));
    expect(ctors.length).toBeGreaterThanOrEqual(2);
  });
});
