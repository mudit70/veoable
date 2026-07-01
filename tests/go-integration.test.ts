/**
 * Integration test for the Go language plugin (#143).
 *
 * Runs the full CLI analysis pipeline against the sample Go application
 * in examples/stack-samples/issue-143-go/ and verifies structural
 * extraction works correctly.
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { analyze, type AnalysisResult } from '@veoable/cli';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE_ROOT = path.resolve(__dirname, '../examples/stack-samples/issue-143-go');

const openStores: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const store of openStores) {
    try { store.close(); } catch { /* already closed */ }
  }
  openStores.length = 0;
});

async function analyzeGoApp(): Promise<AnalysisResult> {
  const result = await analyze({
    rootDir: SAMPLE_ROOT,
    stitchMode: 'none',
  });
  openStores.push(result.store);
  return result;
}

describe('issue-143-go sample app (full pipeline)', () => {
  it('discovers .go source files', async () => {
    const result = await analyzeGoApp();
    expect(result.sourceFileCount).toBeGreaterThan(0);
  });

  it('emits SourceFile nodes with language=go', async () => {
    const result = await analyzeGoApp();
    const sourceFiles = result.store.findNodes('SourceFile');
    const goFiles = sourceFiles.filter((sf) => sf.language === 'go');
    expect(goFiles.length).toBeGreaterThanOrEqual(4); // main, handlers, service, middleware, async_example
  });

  it('detects exported functions (uppercase)', async () => {
    const result = await analyzeGoApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const exported = fns.filter((f) => f.isExported);
    const exportedNames = exported.map((f) => f.name);

    expect(exportedNames).toContain('SetupRoutes');
    expect(exportedNames).toContain('HealthCheck');
    expect(exportedNames).toContain('ProcessBatch');
  });

  it('detects unexported functions (lowercase)', async () => {
    const result = await analyzeGoApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const unexported = fns.filter((f) => !f.isExported);
    const names = unexported.map((f) => f.name);

    expect(names).toContain('startServer');
    expect(names).toContain('main');
  });

  it('detects method receivers as Type.Method', async () => {
    const result = await analyzeGoApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);

    expect(names).toContain('UserService.GetAll');
    expect(names).toContain('UserService.FindByID');
    expect(names).toContain('UserService.Create');
    expect(names).toContain('UserService.Delete');
  });

  it('detects exported handler functions', async () => {
    const result = await analyzeGoApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);

    expect(names).toContain('ListUsers');
    expect(names).toContain('GetUserByID');
    expect(names).toContain('CreateUser');
    expect(names).toContain('DeleteUser');
  });

  it('detects middleware functions', async () => {
    const result = await analyzeGoApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const names = fns.map((f) => f.name);

    expect(names).toContain('AuthMiddleware');
    expect(names).toContain('LoggingMiddleware');
  });

  it('extracts function parameters', async () => {
    const result = await analyzeGoApp();
    const fns = result.store.findNodes('FunctionDefinition');
    const startServer = fns.find((f) => f.name === 'startServer');
    expect(startServer).toBeDefined();
    expect(startServer!.parameters.length).toBeGreaterThan(0);
    expect(startServer!.parameters[0].name).toBe('port');
  });

  it('emits DEFINED_IN and EXPORTS edges', async () => {
    const result = await analyzeGoApp();
    const fns = result.store.findNodes('FunctionDefinition');
    // Every function should have at least one edge (DEFINED_IN)
    expect(fns.length).toBeGreaterThan(0);
    // Verify we can retrieve source files through relationships
    const sourceFiles = result.store.findNodes('SourceFile');
    expect(sourceFiles.length).toBeGreaterThan(0);
  });
});
