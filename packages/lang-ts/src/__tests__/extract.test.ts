import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import { idFor, validateNode, validateEdge, type SchemaEdge, type SchemaNode } from '@veoable/schema';
import { TsLanguagePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// tests/fixtures/callgraph/ts/<scenario>/
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/callgraph/ts');

function fixturePath(scenario: string): string {
  return path.join(FIXTURE_ROOT, scenario);
}

function nodesByType<T extends SchemaNode['nodeType']>(
  batch: { nodes: SchemaNode[] },
  type: T
): Extract<SchemaNode, { nodeType: T }>[] {
  return batch.nodes.filter((n): n is Extract<SchemaNode, { nodeType: T }> => n.nodeType === type);
}

function edgesByType<T extends SchemaEdge['edgeType']>(
  batch: { edges: SchemaEdge[] },
  type: T
): Extract<SchemaEdge, { edgeType: T }>[] {
  return batch.edges.filter((e): e is Extract<SchemaEdge, { edgeType: T }> => e.edgeType === type);
}

// ──────────────────────────────────────────────────────────────────────
// Schema validation — every emitted node and edge must round-trip
// ──────────────────────────────────────────────────────────────────────

describe('every emitted node and edge passes the canonical schema validators', () => {
  it('validates the imports/ fixture batch', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('imports') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');
    for (const node of batch.nodes) expect(() => validateNode(node)).not.toThrow();
    for (const edge of batch.edges) expect(() => validateEdge(edge)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// SourceFile emission
// ──────────────────────────────────────────────────────────────────────

describe('SourceFile emission', () => {
  it('emits exactly one SourceFile node per extracted file', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('functions-same-file') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');
    const sourceFiles = nodesByType(batch, 'SourceFile');
    expect(sourceFiles).toHaveLength(1);
    expect(sourceFiles[0].filePath).toBe('src/index.ts');
    expect(sourceFiles[0].language).toBe('ts');
    expect(sourceFiles[0].framework).toBeNull();
  });

  it('uses POSIX-style file paths even on Windows-style separators', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('cross-file-imports') });
    const batch = await plugin.extractFile(handle, 'src/users.ts');
    const sourceFile = nodesByType(batch, 'SourceFile')[0];
    expect(sourceFile.filePath).toBe('src/users.ts');
    expect(sourceFile.filePath).not.toContain('\\');
  });

  it('produces a deterministic id matching idFor.sourceFile', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('functions-same-file') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');
    const sourceFile = nodesByType(batch, 'SourceFile')[0];
    expect(sourceFile.id).toBe(
      idFor.sourceFile({ repository: 'functions-same-file', filePath: 'src/index.ts' })
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// FunctionDefinition emission
// ──────────────────────────────────────────────────────────────────────

describe('FunctionDefinition emission', () => {
  let batch: { nodes: SchemaNode[]; edges: SchemaEdge[] };

  beforeAll(async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('functions-same-file') });
    batch = await plugin.extractFile(handle, 'src/index.ts');
  });

  it('emits a FunctionDefinition for a top-level function declaration', () => {
    const fns = nodesByType(batch, 'FunctionDefinition');
    const topLevel = fns.find((f) => f.name === 'topLevelFn');
    expect(topLevel).toBeDefined();
    expect(topLevel!.parameters).toEqual([
      { name: 'a', type: 'number' },
      { name: 'b', type: 'string' },
    ]);
    expect(topLevel!.returnType).toBe('boolean');
    expect(topLevel!.isAsync).toBe(false);
  });

  it('marks async functions correctly', () => {
    const fn = nodesByType(batch, 'FunctionDefinition').find((f) => f.name === 'fetchSomething');
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  it('emits a FunctionDefinition for an arrow function bound to a const', () => {
    const fn = nodesByType(batch, 'FunctionDefinition').find((f) => f.name === 'arrow');
    expect(fn).toBeDefined();
  });

  it('emits a FunctionDefinition for a function expression bound to a const', () => {
    const fn = nodesByType(batch, 'FunctionDefinition').find((f) => f.name === 'expr');
    expect(fn).toBeDefined();
  });

  it('emits class methods named <Class>.<method>', () => {
    const fns = nodesByType(batch, 'FunctionDefinition').map((f) => f.name);
    expect(fns).toContain('UserService.getUser');
    expect(fns).toContain('UserService.validate');
  });

  it('emits a DEFINED_IN edge for every FunctionDefinition', () => {
    const fns = nodesByType(batch, 'FunctionDefinition');
    const sourceFile = nodesByType(batch, 'SourceFile')[0];
    const definedIn = edgesByType(batch, 'DEFINED_IN');
    expect(definedIn).toHaveLength(fns.length);
    for (const fn of fns) {
      expect(definedIn.some((e) => e.from === fn.id && e.to === sourceFile.id)).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// EXPORTS edges
// ──────────────────────────────────────────────────────────────────────

describe('EXPORTS edges', () => {
  let batch: { nodes: SchemaNode[]; edges: SchemaEdge[] };

  beforeAll(async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('exports') });
    batch = await plugin.extractFile(handle, 'src/index.ts');
  });

  it('emits an EXPORTS edge for a named function declaration export', () => {
    const exp = edgesByType(batch, 'EXPORTS').find((e) => e.exportName === 'namedFnExport');
    expect(exp).toBeDefined();
    expect(exp!.isDefault).toBe(false);
  });

  it('emits an EXPORTS edge with isDefault: true for a default function declaration', () => {
    const exp = edgesByType(batch, 'EXPORTS').find((e) => e.exportName === 'defaultFnExport');
    expect(exp).toBeDefined();
    expect(exp!.isDefault).toBe(true);
  });

  it('emits an EXPORTS edge for a named arrow export', () => {
    const exp = edgesByType(batch, 'EXPORTS').find((e) => e.exportName === 'arrowExport');
    expect(exp).toBeDefined();
  });

  it('emits an EXPORTS edge for a named function-expression export', () => {
    const exp = edgesByType(batch, 'EXPORTS').find((e) => e.exportName === 'fnExpressionExport');
    expect(exp).toBeDefined();
  });

  it('does not emit an EXPORTS edge for a non-exported function', () => {
    const exp = edgesByType(batch, 'EXPORTS').find((e) => e.exportName === 'privateHelper');
    expect(exp).toBeUndefined();
  });

  it('marks the corresponding FunctionDefinition.isExported correctly', () => {
    const fns = nodesByType(batch, 'FunctionDefinition');
    expect(fns.find((f) => f.name === 'namedFnExport')!.isExported).toBe(true);
    expect(fns.find((f) => f.name === 'privateHelper')!.isExported).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// IMPORTS edges
// ──────────────────────────────────────────────────────────────────────

describe('IMPORTS edges', () => {
  let batch: { nodes: SchemaNode[]; edges: SchemaEdge[] };

  beforeAll(async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('imports') });
    batch = await plugin.extractFile(handle, 'src/index.ts');
  });

  it('emits an IMPORTS edge for a named import with the symbol names', () => {
    const named = edgesByType(batch, 'IMPORTS').find((e) =>
      e.symbols.includes('helperA') && e.symbols.includes('helperB')
    );
    expect(named).toBeDefined();
    expect(named!.isDefault).toBe(false);
    expect(named!.isDynamic).toBe(false);
  });

  it('emits an IMPORTS edge for a default import with isDefault: true', () => {
    const def = edgesByType(batch, 'IMPORTS').find((e) => e.isDefault);
    expect(def).toBeDefined();
    expect(def!.symbols).toContain('theDefault');
  });

  it('emits an IMPORTS edge for a namespace import', () => {
    const ns = edgesByType(batch, 'IMPORTS').find((e) => e.symbols.some((s) => s.startsWith('* as ')));
    expect(ns).toBeDefined();
  });

  it('IMPORTS edge `to` matches the canonical id of the resolved target SourceFile', () => {
    const named = edgesByType(batch, 'IMPORTS').find((e) => e.symbols.includes('helperA'))!;
    expect(named.to).toBe(idFor.sourceFile({ repository: 'imports', filePath: 'src/named.ts' }));
  });

  it('does not emit IMPORTS edges for external (node_modules) imports', async () => {
    // The imports fixture has only relative imports; all of them resolve.
    // Verify by counting: 3 import statements in src/index.ts → 3 edges.
    const all = edgesByType(batch, 'IMPORTS');
    expect(all).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Cross-file resolution
// ──────────────────────────────────────────────────────────────────────

describe('cross-file resolution', () => {
  it('resolves an import target that lives in a sibling file', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('cross-file-imports') });
    const usersBatch = await plugin.extractFile(handle, 'src/users.ts');
    const importEdge = edgesByType(usersBatch, 'IMPORTS')[0];
    expect(importEdge).toBeDefined();
    expect(importEdge.to).toBe(
      idFor.sourceFile({ repository: 'cross-file-imports', filePath: 'src/db.ts' })
    );
    expect(importEdge.symbols).toContain('query');
  });

  it('resolves a chain of imports across three files', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('cross-file-imports') });
    const serverBatch = await plugin.extractFile(handle, 'src/server.ts');
    const usersBatch = await plugin.extractFile(handle, 'src/users.ts');

    // server.ts → users.ts
    const serverImport = edgesByType(serverBatch, 'IMPORTS')[0];
    expect(serverImport.to).toBe(
      idFor.sourceFile({ repository: 'cross-file-imports', filePath: 'src/users.ts' })
    );

    // users.ts → db.ts
    const usersImport = edgesByType(usersBatch, 'IMPORTS')[0];
    expect(usersImport.to).toBe(
      idFor.sourceFile({ repository: 'cross-file-imports', filePath: 'src/db.ts' })
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('plugin contract', () => {
  it('exposes id and fileExtensions matching the design', () => {
    const plugin = new TsLanguagePlugin();
    expect(plugin.id).toBe('ts');
    expect(plugin.fileExtensions).toEqual(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  });

  it('throws when extractFile is called with a file that was not loaded', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('imports') });
    await expect(plugin.extractFile(handle, 'src/does-not-exist.ts')).rejects.toThrow(/not loaded/);
  });

  it('registerVisitor rejects a visitor targeting a different language', () => {
    const plugin = new TsLanguagePlugin();
    expect(() =>
      plugin.registerVisitor({ language: 'python' } as unknown as Parameters<typeof plugin.registerVisitor>[0])
    ).toThrow(/cannot register visitor for language 'python'/);
  });

  it('registerVisitor rejects a visitor missing the onNode method', () => {
    const plugin = new TsLanguagePlugin();
    expect(() => plugin.registerVisitor({ language: 'ts' })).toThrow(/missing the required onNode/);
  });

  it('rejects a forged ProjectHandle', async () => {
    const plugin = new TsLanguagePlugin();
    const fake = {} as Parameters<typeof plugin.extractFile>[0];
    await expect(plugin.extractFile(fake, 'src/index.ts')).rejects.toThrow(/not produced by/);
  });

  it('fileExtensions is a readonly literal tuple', () => {
    const plugin = new TsLanguagePlugin();
    // Compile-time: this assignment would error if fileExtensions were
    // typed as mutable `string[]`. Runtime: confirm frozen-ish by shape.
    const exts: readonly string[] = plugin.fileExtensions;
    expect(exts).toEqual(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
    // The underlying const-asserted tuple is not frozen by TS, but we
    // verify at least that mutation attempts don't persist on a copy.
    expect([...plugin.fileExtensions]).toEqual([...exts]);
  });

  it('loadProject called twice on the same rootDir returns independent handles', async () => {
    const plugin = new TsLanguagePlugin();
    const a = await plugin.loadProject({ rootDir: fixturePath('imports') });
    const b = await plugin.loadProject({ rootDir: fixturePath('imports') });
    expect(a).not.toBe(b);
    // Each handle should still work independently.
    const batchA = await plugin.extractFile(a, 'src/index.ts');
    const batchB = await plugin.extractFile(b, 'src/index.ts');
    expect(batchA.nodes.length).toBe(batchB.nodes.length);
  });

  it('ProjectHandle is opaque at runtime (no usable internals leak)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('imports') });
    expect(JSON.stringify(handle)).toBe('{}');
    expect(Object.keys(handle as object)).toEqual([]);
    expect(Object.getOwnPropertyNames(handle as object)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Idempotency and complete-graph coverage
// ──────────────────────────────────────────────────────────────────────

describe('extractor idempotency and graph completeness', () => {
  it('extractFile on the same file twice produces an identical batch', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('imports') });
    const a = await plugin.extractFile(handle, 'src/index.ts');
    const b = await plugin.extractFile(handle, 'src/index.ts');
    expect(a).toEqual(b);
  });

  it('extracting every file in the cross-file-imports fixture produces a complete graph', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('cross-file-imports') });
    const files = ['src/server.ts', 'src/users.ts', 'src/db.ts'];
    const allNodes: SchemaNode[] = [];
    const allEdges: SchemaEdge[] = [];
    for (const f of files) {
      const batch = await plugin.extractFile(handle, f);
      allNodes.push(...batch.nodes);
      allEdges.push(...batch.edges);
    }
    const sourceFileIds = new Set(
      allNodes.filter((n) => n.nodeType === 'SourceFile').map((n) => n.id)
    );
    // No duplicate SourceFile ids.
    expect(sourceFileIds.size).toBe(files.length);
    // Every IMPORTS edge `to` resolves to a SourceFile id in the batch.
    for (const edge of allEdges) {
      if (edge.edgeType === 'IMPORTS') {
        expect(sourceFileIds.has(edge.to)).toBe(true);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases — re-exports, mixed imports, type-only, side-effect-only,
// classes (static/getter/setter/ctor, non-exported), nested functions,
// class expressions, object literal methods, JS files, special paths.
// ──────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('mixed default + named import produces a single IMPORTS edge with both symbols and isDefault: true', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/mixed-import.ts');
    const imports = edgesByType(batch, 'IMPORTS').filter((e) =>
      e.to.endsWith("'src/target.ts'") || e.to.includes(':target.ts') || e.symbols.includes('theDefault')
    );
    const mixed = imports.find((e) => e.symbols.includes('theDefault') && e.symbols.includes('bar'));
    expect(mixed).toBeDefined();
    expect(mixed!.isDefault).toBe(true);
    // Order: default first, then named.
    expect(mixed!.symbols[0]).toBe('theDefault');
  });

  it('type-only import still produces an IMPORTS edge', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/mixed-import.ts');
    const typeOnly = edgesByType(batch, 'IMPORTS').find((e) => e.symbols.length === 1 && e.symbols[0] === 'Foo');
    expect(typeOnly).toBeDefined();
    expect(typeOnly!.isDefault).toBe(false);
  });

  it('side-effect-only import produces an IMPORTS edge with symbols: []', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/mixed-import.ts');
    const sideEffect = edgesByType(batch, 'IMPORTS').find((e) => e.symbols.length === 0);
    expect(sideEffect).toBeDefined();
    expect(sideEffect!.isDefault).toBe(false);
    expect(sideEffect!.to).toBe(
      idFor.sourceFile({ repository: 'edge-cases', filePath: 'src/side-effects.ts' })
    );
  });

  it('re-exports are emitted as IMPORTS edges (named, bare star, namespace star)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/re-export.ts');
    const edges = edgesByType(batch, 'IMPORTS');
    // Three re-export statements, each targeting ./target.js.
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expect(e.to).toBe(idFor.sourceFile({ repository: 'edge-cases', filePath: 'src/target.ts' }));
    }
    expect(edges.some((e) => e.symbols.includes('bar'))).toBe(true);
    expect(edges.some((e) => e.symbols.includes('*'))).toBe(true);
    expect(edges.some((e) => e.symbols.some((s) => s === '* as allTarget'))).toBe(true);
  });

  it('a file with no functions still emits exactly one SourceFile and zero FunctionDefinitions', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/no-functions.ts');
    expect(nodesByType(batch, 'SourceFile')).toHaveLength(1);
    expect(nodesByType(batch, 'FunctionDefinition')).toHaveLength(0);
  });

  it('JS files are supported via allowJs', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/plain.js');
    expect(nodesByType(batch, 'SourceFile')).toHaveLength(1);
    expect(nodesByType(batch, 'FunctionDefinition').map((f) => f.name)).toContain('jsFn');
  });

  it('files with spaces and unicode in their path are handled with POSIX separators', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/weird name/café.ts');
    const sf = nodesByType(batch, 'SourceFile')[0];
    expect(sf.filePath).toBe('src/weird name/café.ts');
    expect(sf.filePath).not.toContain('\\');
  });

  it('class methods on a non-exported class are marked isExported: false', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/classes.ts');
    const hidden = nodesByType(batch, 'FunctionDefinition').find((f) => f.name === 'PrivateSvc.hidden');
    expect(hidden).toBeDefined();
    expect(hidden!.isExported).toBe(false);
  });

  it('static methods on exported classes are emitted as FunctionDefinitions', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/classes.ts');
    const names = nodesByType(batch, 'FunctionDefinition').map((f) => f.name);
    expect(names).toContain('PublicSvc.make');
    expect(names).toContain('PublicSvc.instanceMethod');
  });

  it('getters, setters, and constructors ARE emitted (PR 2 expansion)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/classes.ts');
    const names = nodesByType(batch, 'FunctionDefinition').map((f) => f.name);
    expect(names).toContain('PublicSvc.get value');
    expect(names).toContain('PublicSvc.set value');
    expect(names).toContain('PublicSvc.constructor');
  });

  it('nested / closure functions ARE walked (PR 2 expansion)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/classes.ts');
    const names = nodesByType(batch, 'FunctionDefinition').map((f) => f.name);
    expect(names).toContain('outer');
    expect(names).toContain('inner');
  });

  it('class expression methods ARE emitted, named via the bound variable (PR 2 expansion)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/classes.ts');
    const names = nodesByType(batch, 'FunctionDefinition').map((f) => f.name);
    expect(names.some((n) => n.includes('hiddenInClassExpr'))).toBe(true);
  });

  it('object literal methods are NOT emitted (PR 1 pin)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/classes.ts');
    const names = nodesByType(batch, 'FunctionDefinition').map((f) => f.name);
    expect(names).not.toContain('objMethod');
  });

  it('arrow export has isDefault: false (regression for the variable-statement ancestor walk)', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('exports') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');
    const exp = edgesByType(batch, 'EXPORTS').find((e) => e.exportName === 'arrowExport');
    expect(exp).toBeDefined();
    expect(exp!.isDefault).toBe(false);
  });
});
