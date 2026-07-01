/**
 * Integration test for the Java language plugin (#144).
 *
 * Runs the full CLI analysis pipeline against the sample Java application
 * in examples/stack-samples/issue-144-java/ and verifies structural
 * extraction works correctly.
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { analyze, type AnalysisResult } from '@adorable/cli';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE_ROOT = path.resolve(__dirname, '../examples/stack-samples/issue-144-java');

const openStores: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const store of openStores) {
    try { store.close(); } catch { /* already closed */ }
  }
  openStores.length = 0;
});

async function analyzeJavaApp(): Promise<AnalysisResult> {
  const result = await analyze({
    rootDir: SAMPLE_ROOT,
    stitchMode: 'none',
  });
  openStores.push(result.store);
  return result;
}

describe('issue-144-java sample app (full pipeline)', () => {
  it('discovers .java source files', async () => {
    const result = await analyzeJavaApp();
    expect(result.sourceFileCount).toBeGreaterThan(0);
  });

  it('emits SourceFile nodes with language=java', async () => {
    const result = await analyzeJavaApp();
    const sourceFiles = result.store.findNodes('SourceFile');
    const javaFiles = sourceFiles.filter((sf) => sf.language === 'java');
    expect(javaFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('detects public methods as exported', async () => {
    const result = await analyzeJavaApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const exported = fns.filter((f) => f.isExported);
    const names = exported.map((f) => f.name);

    expect(names).toContain('UserController.listUsers');
    expect(names).toContain('UserService.getAllUsers');
    expect(names).toContain('UserService.createUser');
  });

  it('detects private methods as not exported', async () => {
    const result = await analyzeJavaApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const validateUser = fns.find((f) => f.name === 'UserService.validateUser');
    expect(validateUser).toBeDefined();
    expect(validateUser!.isExported).toBe(false);
  });

  it('detects interface methods', async () => {
    const result = await analyzeJavaApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);
    expect(names).toContain('UserRepository.findAll');
    expect(names).toContain('UserRepository.findById');
  });

  it('detects model class methods (getters/setters)', async () => {
    const result = await analyzeJavaApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);
    expect(names).toContain('User.getId');
    expect(names).toContain('User.setName');
    expect(names).toContain('User.getEmail');
  });

  it('detects constructors', async () => {
    const result = await analyzeJavaApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const ctors = fns.filter((f) => f.name.endsWith('.constructor'));
    expect(ctors.length).toBeGreaterThanOrEqual(2);
  });

  it('detects static main entry point', async () => {
    const result = await analyzeJavaApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const main = fns.find((f) => f.name === 'UserApiApplication.main');
    expect(main).toBeDefined();
    expect(main!.isExported).toBe(true);
  });
});
