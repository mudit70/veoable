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
import { JavaLanguagePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/java/basic/src');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new JavaLanguagePlugin();
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
  it('emits a SourceFile node with language="java"', async () => {
    const batch = await extract('Main.java');
    const sfs = sourceFiles(batch);
    expect(sfs).toHaveLength(1);
    expect(sfs[0].language).toBe('java');
    expect(sfs[0].filePath).toBe('Main.java');
  });

  it('SourceFile passes schema validation', async () => {
    const batch = await extract('Main.java');
    for (const sf of sourceFiles(batch)) {
      expect(() => validateNode(sf)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Method detection
// ──────────────────────────────────────────────────────────────────────

describe('method detection', () => {
  it('detects all methods in a class as ClassName.methodName', async () => {
    const batch = await extract('Main.java');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('Main.greet');
    expect(names).toContain('Main.formatGreeting');
    expect(names).toContain('Main.add');
    expect(names).toContain('Main.processData');
    expect(names).toContain('Main.doNothing');
    expect(names).toContain('Main.caller');
    expect(names).toContain('Main.main');
  });

  it('marks public methods as exported', async () => {
    const batch = await extract('Main.java');
    const greet = functions(batch).find((f) => f.name === 'Main.greet');
    expect(greet).toBeDefined();
    expect(greet!.isExported).toBe(true);
  });

  it('marks private methods as not exported', async () => {
    const batch = await extract('Main.java');
    const fmt = functions(batch).find((f) => f.name === 'Main.formatGreeting');
    expect(fmt).toBeDefined();
    expect(fmt!.isExported).toBe(false);
  });

  it('extracts parameters with types', async () => {
    const batch = await extract('Main.java');
    const greet = functions(batch).find((f) => f.name === 'Main.greet');
    expect(greet).toBeDefined();
    expect(greet!.parameters).toHaveLength(1);
    expect(greet!.parameters[0].name).toBe('name');
    expect(greet!.parameters[0].type).toBe('String');
  });

  it('extracts multiple parameters', async () => {
    const batch = await extract('Main.java');
    const add = functions(batch).find((f) => f.name === 'Main.add');
    expect(add).toBeDefined();
    expect(add!.parameters).toHaveLength(2);
    expect(add!.parameters[0].name).toBe('a');
    expect(add!.parameters[0].type).toBe('int');
    expect(add!.parameters[1].name).toBe('b');
  });

  it('extracts return type', async () => {
    const batch = await extract('Main.java');
    const greet = functions(batch).find((f) => f.name === 'Main.greet');
    expect(greet).toBeDefined();
    expect(greet!.returnType).toBe('String');
  });

  it('extracts void return type', async () => {
    const batch = await extract('Main.java');
    const doNothing = functions(batch).find((f) => f.name === 'Main.doNothing');
    expect(doNothing).toBeDefined();
    expect(doNothing!.returnType).toBe('void');
  });

  it('every FunctionDefinition passes schema validation', async () => {
    const batch = await extract('Main.java');
    for (const fn of functions(batch)) {
      expect(() => validateNode(fn)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Interfaces and implementation
// ──────────────────────────────────────────────────────────────────────

describe('interfaces and implementation', () => {
  it('detects interface methods as InterfaceName.methodName', async () => {
    const batch = await extract('Service.java');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('Repository.findAll');
    expect(names).toContain('Repository.findById');
  });

  it('detects implementing class methods', async () => {
    const batch = await extract('Service.java');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('UserServiceImpl.findAll');
    expect(names).toContain('UserServiceImpl.findById');
    expect(names).toContain('UserServiceImpl.addUser');
  });

  it('detects package-private methods as not exported', async () => {
    const batch = await extract('Service.java');
    const internal = functions(batch).find((f) => f.name === 'UserServiceImpl.internalProcess');
    expect(internal).toBeDefined();
    expect(internal!.isExported).toBe(false);
  });

  it('detects constructors', async () => {
    const batch = await extract('Service.java');
    const ctor = functions(batch).find((f) => f.name === 'UserServiceImpl.constructor');
    expect(ctor).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('detects varargs parameters', async () => {
    const batch = await extract('EdgeCases.java');
    const fn = functions(batch).find((f) => f.name === 'EdgeCases.joinStrings');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(2);
    expect(fn!.parameters[0].name).toBe('separator');
    expect(fn!.parameters[1].name).toBe('...items');
  });

  it('detects generic methods', async () => {
    const batch = await extract('EdgeCases.java');
    const fn = functions(batch).find((f) => f.name === 'EdgeCases.wrapInList');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(1);
  });

  it('detects annotated methods', async () => {
    const batch = await extract('EdgeCases.java');
    const fn = functions(batch).find((f) => f.name === 'EdgeCases.oldMethod');
    expect(fn).toBeDefined();
    // @Deprecated is an annotation, not a modifier — method should still be public
    expect(fn!.isExported).toBe(true);
  });

  it('detects methods with throws clause', async () => {
    const batch = await extract('EdgeCases.java');
    const fn = functions(batch).find((f) => f.name === 'EdgeCases.riskyMethod');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toBe('void');
  });

  it('detects inner class methods as OuterClass.InnerClass.method', async () => {
    const batch = await extract('EdgeCases.java');
    const fn = functions(batch).find((f) => f.name === 'EdgeCases.InnerHelper.help');
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(true);
  });

  it('detects lambda-returning methods', async () => {
    const batch = await extract('EdgeCases.java');
    const fn = functions(batch).find((f) => f.name === 'EdgeCases.createTask');
    expect(fn).toBeDefined();
  });

  it('detects generic return types (m5)', async () => {
    const batch = await extract('EdgeCases.java');
    const fn = functions(batch).find((f) => f.name === 'EdgeCases.getMetadata');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toContain('Map');
  });

  it('resolves forward references within same class (M1 two-pass)', async () => {
    const batch = await extract('EdgeCases.java');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const publicApi = functions(batch).find((f) => f.name === 'EdgeCases.publicApi');
    const privateHelper = functions(batch).find((f) => f.name === 'EdgeCases.privateHelper');
    expect(publicApi).toBeDefined();
    expect(privateHelper).toBeDefined();

    // publicApi calls privateHelper (defined LATER in the class)
    const edge = calls.find((e) => e.from === publicApi!.id && e.to === privateHelper!.id);
    expect(edge).toBeDefined();
  });

  it('resolves this.method() calls (M3)', async () => {
    const batch = await extract('EdgeCases.java');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'EdgeCases.callerUsingThis');
    const target = functions(batch).find((f) => f.name === 'EdgeCases.oldMethod');
    expect(caller).toBeDefined();
    expect(target).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === target!.id);
    expect(edge).toBeDefined();
  });

  it('detects enum methods (M4)', async () => {
    const batch = await extract('EdgeCases.java');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('Color.display');
    expect(names).toContain('Color.isPrimary');
  });

  it('marks interface methods as exported (n1)', async () => {
    const batch = await extract('Service.java');
    const findAll = functions(batch).find((f) => f.name === 'Repository.findAll');
    expect(findAll).toBeDefined();
    expect(findAll!.isExported).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Call graph
// ──────────────────────────────────────────────────────────────────────

describe('call graph edges', () => {
  it('detects unqualified method calls within the same class', async () => {
    const batch = await extract('Main.java');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'Main.caller');
    const greet = functions(batch).find((f) => f.name === 'Main.greet');
    expect(caller).toBeDefined();
    expect(greet).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === greet!.id);
    expect(edge).toBeDefined();
  });

  it('detects static method calls', async () => {
    const batch = await extract('Main.java');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'Main.caller');
    const add = functions(batch).find((f) => f.name === 'Main.add');
    expect(caller).toBeDefined();
    expect(add).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === add!.id);
    expect(edge).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge emission
// ──────────────────────────────────────────────────────────────────────

describe('edge emission', () => {
  it('emits DEFINED_IN edge for every function', async () => {
    const batch = await extract('Main.java');
    const fns = functions(batch);
    const definedIn = edgesOfType(batch, 'DEFINED_IN');
    expect(definedIn.length).toBe(fns.length);
  });

  it('emits EXPORTS edges for public methods only', async () => {
    const batch = await extract('Main.java');
    const exports = edgesOfType(batch, 'EXPORTS');
    const publicFns = functions(batch).filter((f) => f.isExported);
    expect(exports.length).toBe(publicFns.length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('JavaLanguagePlugin contract', () => {
  it('has id="java" and fileExtensions=[".java"]', () => {
    const plugin = new JavaLanguagePlugin();
    expect(plugin.id).toBe('java');
    expect(plugin.fileExtensions).toEqual(['.java']);
  });

  it('rejects visitors with wrong language tag', () => {
    const plugin = new JavaLanguagePlugin();
    expect(() =>
      plugin.registerVisitor({ language: 'ts', onNode: () => {} } as any)
    ).toThrow(/must be 'java'/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end with canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('all nodes commit cleanly and round-trip', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new JavaLanguagePlugin();
      const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });

      for (const file of ['Main.java', 'Service.java', 'EdgeCases.java']) {
        const batch = await plugin.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('java'));
      }

      const allSourceFiles = store.findNodes('SourceFile');
      expect(allSourceFiles.filter((sf) => sf.language === 'java').length).toBe(3);

      const allFunctions = store.findNodes('FunctionDefinition');
      expect(allFunctions.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
