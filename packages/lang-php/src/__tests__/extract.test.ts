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
import { PhpLanguagePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/php/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new PhpLanguagePlugin();
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
  it('emits a SourceFile node with language="php"', async () => {
    const batch = await extract('main.php');
    const sfs = sourceFiles(batch);
    expect(sfs).toHaveLength(1);
    expect(sfs[0].language).toBe('php');
  });

  it('passes schema validation', async () => {
    const batch = await extract('main.php');
    for (const sf of sourceFiles(batch)) {
      expect(() => validateNode(sf)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Top-level function detection
// ──────────────────────────────────────────────────────────────────────

describe('top-level function detection', () => {
  it('detects all top-level functions', async () => {
    const batch = await extract('main.php');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('greet');
    expect(names).toContain('formatGreeting');
    expect(names).toContain('add');
    expect(names).toContain('caller');
  });

  it('marks top-level functions as exported', async () => {
    const batch = await extract('main.php');
    for (const fn of functions(batch)) {
      expect(fn.isExported).toBe(true);
    }
  });

  it('extracts parameters with types', async () => {
    const batch = await extract('main.php');
    const greet = functions(batch).find((f) => f.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.parameters).toHaveLength(1);
    expect(greet!.parameters[0].name).toBe('name');
    expect(greet!.parameters[0].type).toBe('string');
  });

  it('extracts return type', async () => {
    const batch = await extract('main.php');
    const greet = functions(batch).find((f) => f.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.returnType).toBe('string');
  });

  it('extracts void return type', async () => {
    const batch = await extract('main.php');
    const caller = functions(batch).find((f) => f.name === 'caller');
    expect(caller).toBeDefined();
    expect(caller!.returnType).toBe('void');
  });

  it('every FunctionDefinition passes schema validation', async () => {
    const batch = await extract('main.php');
    for (const fn of functions(batch)) {
      expect(() => validateNode(fn)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Class method detection
// ──────────────────────────────────────────────────────────────────────

describe('class method detection', () => {
  it('detects class methods as ClassName.methodName', async () => {
    const batch = await extract('service.php');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('UserService.findAll');
    expect(names).toContain('UserService.findById');
    expect(names).toContain('UserService.addUser');
  });

  it('detects constructors as ClassName.constructor', async () => {
    const batch = await extract('service.php');
    const ctor = functions(batch).find((f) => f.name === 'UserService.constructor');
    expect(ctor).toBeDefined();
  });

  it('marks public methods as exported', async () => {
    const batch = await extract('service.php');
    const findAll = functions(batch).find((f) => f.name === 'UserService.findAll');
    expect(findAll).toBeDefined();
    expect(findAll!.isExported).toBe(true);
  });

  it('marks private methods as not exported', async () => {
    const batch = await extract('service.php');
    const internal = functions(batch).find((f) => f.name === 'UserService.internalProcess');
    expect(internal).toBeDefined();
    expect(internal!.isExported).toBe(false);
  });

  it('marks protected methods as exported', async () => {
    const batch = await extract('service.php');
    const validate = functions(batch).find((f) => f.name === 'UserService.validate');
    expect(validate).toBeDefined();
    expect(validate!.isExported).toBe(true);
  });

  it('detects interface methods as exported', async () => {
    const batch = await extract('service.php');
    const findAll = functions(batch).find((f) => f.name === 'Repository.findAll');
    expect(findAll).toBeDefined();
    expect(findAll!.isExported).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('detects abstract class methods', async () => {
    const batch = await extract('edge_cases.php');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('BaseService.process');
    expect(names).toContain('BaseService.log');
  });

  it('detects trait methods', async () => {
    const batch = await extract('edge_cases.php');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('Timestampable.getCreatedAt');
  });

  it('detects variadic parameters', async () => {
    const batch = await extract('edge_cases.php');
    const fn = functions(batch).find((f) => f.name === 'ItemService.processItems');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(1);
    expect(fn!.parameters[0].name).toBe('...items');
    expect(fn!.parameters[0].type).toBe('string');
  });

  it('detects static methods', async () => {
    const batch = await extract('edge_cases.php');
    const fn = functions(batch).find((f) => f.name === 'ItemService.create');
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(true);
  });

  it('resolves forward references within class (two-pass)', async () => {
    const batch = await extract('edge_cases.php');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const publicApi = functions(batch).find((f) => f.name === 'ItemService.publicApi');
    const privateHelper = functions(batch).find((f) => f.name === 'ItemService.privateHelper');
    expect(publicApi).toBeDefined();
    expect(privateHelper).toBeDefined();

    const edge = calls.find((e) => e.from === publicApi!.id && e.to === privateHelper!.id);
    expect(edge).toBeDefined();
  });

  it('resolves self::method() scoped calls (M1 fix)', async () => {
    const batch = await extract('edge_cases.php');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'ItemService.callViaStatic');
    const target = functions(batch).find((f) => f.name === 'ItemService.create');
    expect(caller).toBeDefined();
    expect(target).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === target!.id);
    expect(edge).toBeDefined();
  });

  it('resolves $this->method() same-class calls (m5)', async () => {
    const batch = await extract('edge_cases.php');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'ItemService.callViaThis');
    const target = functions(batch).find((f) => f.name === 'ItemService.process');
    expect(caller).toBeDefined();
    expect(target).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === target!.id);
    expect(edge).toBeDefined();
  });

  it('detects PHP 8 constructor property promotion params (m2)', async () => {
    const batch = await extract('edge_cases.php');
    const ctor = functions(batch).find((f) => f.name === 'Config.constructor');
    expect(ctor).toBeDefined();
    expect(ctor!.parameters).toHaveLength(2);
    expect(ctor!.parameters[0].name).toBe('name');
    expect(ctor!.parameters[0].type).toBe('string');
    expect(ctor!.parameters[1].name).toBe('timeout');
    expect(ctor!.parameters[1].type).toBe('int');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Call graph
// ──────────────────────────────────────────────────────────────────────

describe('call graph edges', () => {
  it('detects direct function calls', async () => {
    const batch = await extract('main.php');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'caller');
    const greet = functions(batch).find((f) => f.name === 'greet');
    expect(caller).toBeDefined();
    expect(greet).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === greet!.id);
    expect(edge).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edges
// ──────────────────────────────────────────────────────────────────────

describe('edge emission', () => {
  it('emits DEFINED_IN for every function', async () => {
    const batch = await extract('main.php');
    const fns = functions(batch);
    const definedIn = edgesOfType(batch, 'DEFINED_IN');
    expect(definedIn.length).toBe(fns.length);
  });

  it('emits EXPORTS for exported functions', async () => {
    const batch = await extract('main.php');
    const exports = edgesOfType(batch, 'EXPORTS');
    const exportedFns = functions(batch).filter((f) => f.isExported);
    expect(exports.length).toBe(exportedFns.length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('PhpLanguagePlugin contract', () => {
  it('has id="php" and fileExtensions=[".php"]', () => {
    const plugin = new PhpLanguagePlugin();
    expect(plugin.id).toBe('php');
    expect(plugin.fileExtensions).toEqual(['.php']);
  });

  it('rejects visitors with wrong language tag', () => {
    const plugin = new PhpLanguagePlugin();
    expect(() =>
      plugin.registerVisitor({ language: 'ts', onNode: () => {} } as any)
    ).toThrow(/must be 'php'/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end with canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('all nodes commit cleanly and round-trip', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new PhpLanguagePlugin();
      const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });

      for (const file of ['main.php', 'service.php', 'edge_cases.php']) {
        const batch = await plugin.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('php'));
      }

      const allSourceFiles = store.findNodes('SourceFile');
      expect(allSourceFiles.filter((sf) => sf.language === 'php').length).toBe(3);

      const allFunctions = store.findNodes('FunctionDefinition');
      expect(allFunctions.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
