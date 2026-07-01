import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type SourceFile,
  type FunctionDefinition,
  type SchemaNode,
  type SchemaEdge,
} from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { GoLanguagePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/go/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new GoLanguagePlugin();
  const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });
  return plugin.extractFile(handle, file);
}

function sourceFiles(batch: NodeBatch): SourceFile[] {
  return batch.nodes.filter((n): n is SourceFile => n.nodeType === 'SourceFile');
}

function functions(batch: NodeBatch): FunctionDefinition[] {
  return batch.nodes.filter((n): n is FunctionDefinition => n.nodeType === 'FunctionDefinition');
}

function edgesOfType(batch: NodeBatch, type: string): SchemaEdge[] {
  return batch.edges.filter((e) => e.edgeType === type);
}

// ──────────────────────────────────────────────────────────────────────
// SourceFile emission
// ──────────────────────────────────────────────────────────────────────

describe('SourceFile emission', () => {
  it('emits a SourceFile node with language="go"', async () => {
    const batch = await extract('main.go');
    const sfs = sourceFiles(batch);
    expect(sfs).toHaveLength(1);
    expect(sfs[0].language).toBe('go');
    expect(sfs[0].filePath).toBe('main.go');
  });

  it('SourceFile passes schema validation', async () => {
    const batch = await extract('main.go');
    for (const sf of sourceFiles(batch)) {
      expect(() => validateNode(sf)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Function detection
// ──────────────────────────────────────────────────────────────────────

describe('function detection', () => {
  it('detects all top-level functions', async () => {
    const batch = await extract('main.go');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('ExportedFunc');
    expect(names).toContain('unexportedFunc');
    expect(names).toContain('FuncWithParams');
    expect(names).toContain('formatGreeting');
    expect(names).toContain('CallerFunc');
    expect(names).toContain('main');
  });

  it('marks uppercase functions as exported', async () => {
    const batch = await extract('main.go');
    const fns = functions(batch);
    const exported = fns.find((f) => f.name === 'ExportedFunc');
    expect(exported).toBeDefined();
    expect(exported!.isExported).toBe(true);
  });

  it('marks lowercase functions as not exported', async () => {
    const batch = await extract('main.go');
    const fns = functions(batch);
    const unexported = fns.find((f) => f.name === 'unexportedFunc');
    expect(unexported).toBeDefined();
    expect(unexported!.isExported).toBe(false);
  });

  it('extracts parameters with types', async () => {
    const batch = await extract('main.go');
    const fn = functions(batch).find((f) => f.name === 'FuncWithParams');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(2);
    expect(fn!.parameters[0].name).toBe('name');
    expect(fn!.parameters[0].type).toBe('string');
    expect(fn!.parameters[1].name).toBe('age');
    expect(fn!.parameters[1].type).toBe('int');
  });

  it('extracts return type', async () => {
    const batch = await extract('main.go');
    const fn = functions(batch).find((f) => f.name === 'ExportedFunc');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toBe('string');
  });

  it('every FunctionDefinition passes schema validation', async () => {
    const batch = await extract('main.go');
    for (const fn of functions(batch)) {
      expect(() => validateNode(fn)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Method receivers
// ──────────────────────────────────────────────────────────────────────

describe('method receiver detection', () => {
  it('detects methods with pointer receivers as ReceiverType.Method', async () => {
    const batch = await extract('service.go');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('UserService.GetAll');
    expect(names).toContain('UserService.Create');
  });

  it('detects methods with value receivers as ReceiverType.Method', async () => {
    const batch = await extract('service.go');
    const fns = functions(batch);
    expect(fns.find((f) => f.name === 'UserService.String')).toBeDefined();
  });

  it('marks exported methods correctly', async () => {
    const batch = await extract('service.go');
    const getAll = functions(batch).find((f) => f.name === 'UserService.GetAll');
    expect(getAll).toBeDefined();
    expect(getAll!.isExported).toBe(true);
  });

  it('extracts method parameters (excluding receiver)', async () => {
    const batch = await extract('service.go');
    const create = functions(batch).find((f) => f.name === 'UserService.Create');
    expect(create).toBeDefined();
    expect(create!.parameters).toHaveLength(1);
    expect(create!.parameters[0].name).toBe('name');
  });

  it('detects standalone constructor functions', async () => {
    const batch = await extract('service.go');
    const ctor = functions(batch).find((f) => f.name === 'NewUserService');
    expect(ctor).toBeDefined();
    expect(ctor!.isExported).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge emission
// ──────────────────────────────────────────────────────────────────────

describe('edge emission', () => {
  it('emits DEFINED_IN edge for every function', async () => {
    const batch = await extract('main.go');
    const fns = functions(batch);
    const definedIn = edgesOfType(batch, 'DEFINED_IN');
    // Every function should have exactly one DEFINED_IN edge
    expect(definedIn.length).toBe(fns.length);
  });

  it('emits EXPORTS edges for exported functions only', async () => {
    const batch = await extract('main.go');
    const exports = edgesOfType(batch, 'EXPORTS');
    // ExportedFunc, FuncWithParams, CallerFunc are exported
    // unexportedFunc, formatGreeting, main are not
    const exportedNames = functions(batch).filter((f) => f.isExported).map((f) => f.name);
    expect(exports.length).toBe(exportedNames.length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Call graph
// ──────────────────────────────────────────────────────────────────────

describe('call graph edges', () => {
  it('detects direct function calls', async () => {
    const batch = await extract('main.go');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    expect(calls.length).toBeGreaterThan(0);

    // CallerFunc calls ExportedFunc, unexportedFunc, FuncWithParams
    const callerFn = functions(batch).find((f) => f.name === 'CallerFunc');
    expect(callerFn).toBeDefined();
    const callerEdges = calls.filter((e) => e.from === callerFn!.id);
    expect(callerEdges.length).toBeGreaterThanOrEqual(3);
  });

  it('resolves calls to functions defined earlier in the same file', async () => {
    // Single-pass walk: only resolves forward-declared (defined above) functions.
    // CallerFunc (defined last) calls ExportedFunc, unexportedFunc, FuncWithParams
    // which are all defined before it.
    const batch = await extract('main.go');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const callerFn = functions(batch).find((f) => f.name === 'CallerFunc');
    const exportedFn = functions(batch).find((f) => f.name === 'ExportedFunc');
    expect(callerFn).toBeDefined();
    expect(exportedFn).toBeDefined();

    const edge = calls.find((e) => e.from === callerFn!.id && e.to === exportedFn!.id);
    expect(edge).toBeDefined();
  });

  it('marks conditional calls correctly', async () => {
    const batch = await extract('conditionals.go');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION') as Array<{ from: string; to: string; isConditional: boolean }>;

    // helperA() is called unconditionally by ConditionalCalls
    const unconditionalCall = calls.find(
      (e) => !e.isConditional && functions(batch).find((f) => f.id === e.to)?.name === 'helperA'
    );
    expect(unconditionalCall).toBeDefined();

    // helperB() is called inside if — conditional
    const conditionalCall = calls.find(
      (e) => e.isConditional && functions(batch).find((f) => f.id === e.to)?.name === 'helperB'
    );
    expect(conditionalCall).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases (m2, m3, m4)
// ──────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('detects init() functions', async () => {
    const batch = await extract('edge_cases.go');
    const fns = functions(batch);
    const inits = fns.filter((f) => f.name === 'init');
    // Go allows multiple init() per file — both should be detected
    expect(inits.length).toBe(2);
    // init() is not exported (lowercase)
    for (const fn of inits) {
      expect(fn.isExported).toBe(false);
    }
  });

  it('extracts multi-name params sharing a type: a, b int', async () => {
    const batch = await extract('edge_cases.go');
    const fn = functions(batch).find((f) => f.name === 'MultiParam');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(3);
    expect(fn!.parameters[0]).toEqual({ name: 'a', type: 'int' });
    expect(fn!.parameters[1]).toEqual({ name: 'b', type: 'int' });
    expect(fn!.parameters[2]).toEqual({ name: 'c', type: 'string' });
  });

  it('handles unnamed params with _ as name', async () => {
    const batch = await extract('edge_cases.go');
    const fn = functions(batch).find((f) => f.name === 'UnnamedParams');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(2);
    expect(fn!.parameters[0].name).toBe('_');
    expect(fn!.parameters[0].type).toBe('int');
    expect(fn!.parameters[1].name).toBe('_');
    expect(fn!.parameters[1].type).toBe('string');
  });

  it('handles blank identifier _ in parameter list', async () => {
    const batch = await extract('edge_cases.go');
    const fn = functions(batch).find((f) => f.name === 'BlankIdentifier');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(2);
    expect(fn!.parameters[0].name).toBe('_');
    expect(fn!.parameters[1].name).toBe('name');
  });

  it('extracts variadic parameter type', async () => {
    const batch = await extract('edge_cases.go');
    const fn = functions(batch).find((f) => f.name === 'VariadicFunc');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(2);
    expect(fn!.parameters[0]).toEqual({ name: 'prefix', type: 'string' });
    expect(fn!.parameters[1].name).toBe('...items');
    expect(fn!.parameters[1].type).toBe('...string');
  });

  it('extracts multi-return type as tuple string', async () => {
    const batch = await extract('edge_cases.go');
    const fn = functions(batch).find((f) => f.name === 'MultiReturn');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toBe('(string, error)');
  });

  it('also extracts multi-return from main.go fixture', async () => {
    const batch = await extract('main.go');
    const fn = functions(batch).find((f) => f.name === 'FuncWithParams');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toBe('(string, error)');
  });

  it('detects closure-returning functions', async () => {
    const batch = await extract('edge_cases.go');
    const fn = functions(batch).find((f) => f.name === 'ClosureExample');
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(true);
  });

  it('detects GoroutineExample function', async () => {
    const batch = await extract('edge_cases.go');
    const fn = functions(batch).find((f) => f.name === 'GoroutineExample');
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('GoLanguagePlugin contract', () => {
  it('has id="go" and fileExtensions=[".go"]', () => {
    const plugin = new GoLanguagePlugin();
    expect(plugin.id).toBe('go');
    expect(plugin.fileExtensions).toEqual(['.go']);
  });

  it('rejects visitors with wrong language tag', () => {
    const plugin = new GoLanguagePlugin();
    expect(() =>
      plugin.registerVisitor({ language: 'ts', onNode: () => {} } as any)
    ).toThrow(/must be 'go'/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end with canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('all nodes commit cleanly and round-trip', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new GoLanguagePlugin();
      const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });

      for (const file of ['main.go', 'service.go', 'conditionals.go', 'edge_cases.go']) {
        const batch = await plugin.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('go'));
      }

      const allSourceFiles = store.findNodes('SourceFile');
      expect(allSourceFiles.filter((sf) => sf.language === 'go').length).toBe(4);

      const allFunctions = store.findNodes('FunctionDefinition');
      expect(allFunctions.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
