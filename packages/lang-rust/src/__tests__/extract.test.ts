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
import { RustLanguagePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/rust/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new RustLanguagePlugin();
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
  it('emits a SourceFile with language="rust"', async () => {
    const batch = await extract('main.rs');
    const sfs = sourceFiles(batch);
    expect(sfs).toHaveLength(1);
    expect(sfs[0].language).toBe('rust');
  });

  it('passes schema validation', async () => {
    const batch = await extract('main.rs');
    for (const sf of sourceFiles(batch)) {
      expect(() => validateNode(sf)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Function detection
// ──────────────────────────────────────────────────────────────────────

describe('top-level function detection', () => {
  it('detects all top-level functions', async () => {
    const batch = await extract('main.rs');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('greet');
    expect(names).toContain('format_greeting');
    expect(names).toContain('fetch_data');
    expect(names).toContain('caller');
    expect(names).toContain('main');
  });

  it('marks pub functions as exported', async () => {
    const batch = await extract('main.rs');
    const greet = functions(batch).find((f) => f.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.isExported).toBe(true);
  });

  it('marks non-pub functions as not exported', async () => {
    const batch = await extract('main.rs');
    const fmt = functions(batch).find((f) => f.name === 'format_greeting');
    expect(fmt).toBeDefined();
    expect(fmt!.isExported).toBe(false);
  });

  it('detects async functions', async () => {
    const batch = await extract('main.rs');
    const fn = functions(batch).find((f) => f.name === 'fetch_data');
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  it('marks non-async functions correctly', async () => {
    const batch = await extract('main.rs');
    const fn = functions(batch).find((f) => f.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(false);
  });

  it('extracts parameters with types', async () => {
    const batch = await extract('main.rs');
    const greet = functions(batch).find((f) => f.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.parameters).toHaveLength(1);
    expect(greet!.parameters[0].name).toBe('name');
    expect(greet!.parameters[0].type).toBe('&str');
  });

  it('extracts return type', async () => {
    const batch = await extract('main.rs');
    const greet = functions(batch).find((f) => f.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.returnType).toBe('String');
  });

  it('every FunctionDefinition passes schema validation', async () => {
    const batch = await extract('main.rs');
    for (const fn of functions(batch)) {
      expect(() => validateNode(fn)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Impl block methods
// ──────────────────────────────────────────────────────────────────────

describe('impl block method detection', () => {
  it('detects methods in impl blocks as Type.method', async () => {
    const batch = await extract('service.rs');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('UserService.new');
    expect(names).toContain('UserService.get_all');
    expect(names).toContain('UserService.find_by_id');
    expect(names).toContain('UserService.internal_process');
  });

  it('marks pub methods as exported', async () => {
    const batch = await extract('service.rs');
    const fn = functions(batch).find((f) => f.name === 'UserService.get_all');
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(true);
  });

  it('marks non-pub methods as not exported', async () => {
    const batch = await extract('service.rs');
    const fn = functions(batch).find((f) => f.name === 'UserService.internal_process');
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(false);
  });

  it('detects async methods', async () => {
    const batch = await extract('service.rs');
    const fn = functions(batch).find((f) => f.name === 'UserService.fetch_remote');
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  it('skips self parameter in parameter list', async () => {
    const batch = await extract('service.rs');
    const fn = functions(batch).find((f) => f.name === 'UserService.get_all');
    expect(fn).toBeDefined();
    // &self should not appear in parameters
    expect(fn!.parameters).toHaveLength(0);
  });

  it('extracts non-self parameters', async () => {
    const batch = await extract('service.rs');
    const fn = functions(batch).find((f) => f.name === 'UserService.find_by_id');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(1);
    expect(fn!.parameters[0].name).toBe('id');
    expect(fn!.parameters[0].type).toBe('u64');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Trait declarations and implementations
// ──────────────────────────────────────────────────────────────────────

describe('trait detection', () => {
  it('detects trait method signatures', async () => {
    const batch = await extract('service.rs');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('Repository.find_all');
    expect(names).toContain('Repository.find_by_id');
  });

  it('detects trait impl methods as Type.method', async () => {
    const batch = await extract('service.rs');
    const fns = functions(batch);
    // impl Repository for UserService should produce UserService.find_all
    const traitImpl = fns.find((f) => f.name === 'UserService.find_all');
    expect(traitImpl).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('detects enum impl methods', async () => {
    const batch = await extract('edge_cases.rs');
    const fns = functions(batch);
    const names = fns.map((f) => f.name);
    expect(names).toContain('Color.display');
  });

  it('detects trait impl on enum (Display for Color)', async () => {
    const batch = await extract('edge_cases.rs');
    const fns = functions(batch);
    const fmt = fns.find((f) => f.name === 'Color.fmt');
    expect(fmt).toBeDefined();
  });

  it('detects pub(crate) as exported', async () => {
    const batch = await extract('edge_cases.rs');
    const fn = functions(batch).find((f) => f.name === 'crate_visible');
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(true);
  });

  it('detects Result return type', async () => {
    const batch = await extract('edge_cases.rs');
    const fn = functions(batch).find((f) => f.name === 'parse_number');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toContain('Result');
  });

  it('resolves Type::method() scoped calls', async () => {
    const batch = await extract('edge_cases.rs');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'static_call_test');
    const target = functions(batch).find((f) => f.name === 'EdgeService.new');
    expect(caller).toBeDefined();
    expect(target).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === target!.id);
    expect(edge).toBeDefined();
  });

  it('resolves Self::method() within impl blocks (M1 fix)', async () => {
    const batch = await extract('edge_cases.rs');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'EdgeService.create_default');
    const target = functions(batch).find((f) => f.name === 'EdgeService.new');
    expect(caller).toBeDefined();
    expect(target).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === target!.id);
    expect(edge).toBeDefined();
  });

  it('resolves self.method() within impl blocks', async () => {
    const batch = await extract('service.rs');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'UserService.do_work');
    const target = functions(batch).find((f) => f.name === 'UserService.internal_process');
    expect(caller).toBeDefined();
    expect(target).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === target!.id);
    expect(edge).toBeDefined();
  });

  it('resolves forward references between top-level functions (M2 fix)', async () => {
    const batch = await extract('edge_cases.rs');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'forward_ref_caller');
    const target = functions(batch).find((f) => f.name === 'forward_ref_target');
    expect(caller).toBeDefined();
    expect(target).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === target!.id);
    expect(edge).toBeDefined();
  });

  it('attributes closure calls to enclosing function (n2)', async () => {
    const batch = await extract('edge_cases.rs');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const closureFn = functions(batch).find((f) => f.name === 'closure_test');
    expect(closureFn).toBeDefined();

    // with_callback is called from within closure_test
    const target = functions(batch).find((f) => f.name === 'with_callback');
    expect(target).toBeDefined();

    const edge = calls.find((e) => e.from === closureFn!.id && e.to === target!.id);
    expect(edge).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Call graph
// ──────────────────────────────────────────────────────────────────────

describe('call graph edges', () => {
  it('detects direct function calls', async () => {
    const batch = await extract('main.rs');
    const calls = edgesOfType(batch, 'CALLS_FUNCTION');
    const caller = functions(batch).find((f) => f.name === 'caller');
    const greet = functions(batch).find((f) => f.name === 'greet');
    expect(caller).toBeDefined();
    expect(greet).toBeDefined();

    const edge = calls.find((e) => e.from === caller!.id && e.to === greet!.id);
    expect(edge).toBeDefined();
  });

  it('emits DEFINED_IN for every function', async () => {
    const batch = await extract('main.rs');
    expect(edgesOfType(batch, 'DEFINED_IN').length).toBe(functions(batch).length);
  });

  it('emits EXPORTS for pub functions only', async () => {
    const batch = await extract('main.rs');
    const exports = edgesOfType(batch, 'EXPORTS');
    const pubFns = functions(batch).filter((f) => f.isExported);
    expect(exports.length).toBe(pubFns.length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('RustLanguagePlugin contract', () => {
  it('has id="rust" and fileExtensions=[".rs"]', () => {
    const plugin = new RustLanguagePlugin();
    expect(plugin.id).toBe('rust');
    expect(plugin.fileExtensions).toEqual(['.rs']);
  });

  it('rejects visitors with wrong language tag', () => {
    const plugin = new RustLanguagePlugin();
    expect(() =>
      plugin.registerVisitor({ language: 'ts', onNode: () => {} } as any)
    ).toThrow(/must be 'rust'/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end with canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('all nodes commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new RustLanguagePlugin();
      const handle = await plugin.loadProject({ rootDir: FIXTURE_ROOT });

      for (const file of ['main.rs', 'service.rs', 'edge_cases.rs']) {
        const batch = await plugin.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('rust'));
      }

      const allSourceFiles = store.findNodes('SourceFile');
      expect(allSourceFiles.filter((sf) => sf.language === 'rust').length).toBe(3);

      const allFunctions = store.findNodes('FunctionDefinition');
      expect(allFunctions.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
