import { describe, expect, expectTypeOf, it } from 'vitest';
import type { NodeBatch } from '@adorable/schema';
import type {
  FrameworkPlugin,
  FrameworkVisitor,
  LanguagePlugin,
  ProjectContext,
  ProjectHandle,
  ProjectOptions,
} from '../index.js';

/**
 * These tests are mostly type-level: they construct minimal shapes that
 * satisfy each interface and assert that TypeScript accepts them. Runtime
 * behavior for the plugin interfaces belongs to the concrete plugins that
 * will implement them (#36, #47, #56, #15, …). The purpose here is to
 * lock the shape so a future edit to `language-plugin.ts` that silently
 * breaks the contract fails this file at compile time.
 */

describe('LanguagePlugin shape', () => {
  it('is satisfied by a minimal stub', () => {
    const fakeHandle = { __brand: 'test' } as unknown as ProjectHandle;
    const plugin: LanguagePlugin = {
      id: 'test-lang',
      fileExtensions: ['.test'],
      async loadProject(_opts: ProjectOptions): Promise<ProjectHandle> {
        return fakeHandle;
      },
      async extractFile(_project: ProjectHandle, _filePath: string): Promise<NodeBatch> {
        return { nodes: [], edges: [] };
      },
      registerVisitor(_visitor: FrameworkVisitor): void {
        // no-op
      },
    };
    expect(plugin.id).toBe('test-lang');
    expect(plugin.fileExtensions).toEqual(['.test']);
  });

  it('requires fileExtensions to be a readonly list of strings', () => {
    expectTypeOf<LanguagePlugin['fileExtensions']>().toEqualTypeOf<readonly string[]>();
  });

  it('requires extractFile to return a Promise<NodeBatch>', () => {
    expectTypeOf<LanguagePlugin['extractFile']>().returns.resolves.toEqualTypeOf<NodeBatch>();
  });
});

describe('FrameworkPlugin shape', () => {
  it('is satisfied by a minimal stub', () => {
    const plugin: FrameworkPlugin = {
      id: 'test-framework',
      language: 'test-lang',
      appliesTo(_ctx: ProjectContext): boolean {
        return true;
      },
      visitor: { language: 'test-lang' },
    };
    expect(plugin.id).toBe('test-framework');
    expect(plugin.visitor.language).toBe('test-lang');
  });

  it('requires visitor.language to be a string', () => {
    expectTypeOf<FrameworkPlugin['visitor']['language']>().toEqualTypeOf<string>();
  });
});

describe('LanguagePlugin negative shape', () => {
  it('rejects an object missing required fields', () => {
    // @ts-expect-error — missing fileExtensions, loadProject, extractFile, registerVisitor
    const _bad: LanguagePlugin = { id: 'broken' };
    expect(_bad).toBeDefined();
  });

  it('rejects fileExtensions typed as a non-string array', () => {
    // @ts-expect-error — fileExtensions must be readonly string[]
    const _bad: LanguagePlugin = {
      id: 't',
      fileExtensions: [1, 2],
      async loadProject() {
        return {} as ProjectHandle;
      },
      async extractFile() {
        return { nodes: [], edges: [] };
      },
      registerVisitor() {},
    };
    expect(_bad).toBeDefined();
  });
});

describe('FrameworkPlugin negative shape', () => {
  it('rejects an object missing the visitor field', () => {
    // @ts-expect-error — missing visitor
    const _bad: FrameworkPlugin = {
      id: 'x',
      language: 'ts',
      appliesTo: () => true,
    };
    expect(_bad).toBeDefined();
  });

  it('rejects an object missing language', () => {
    // @ts-expect-error — missing language
    const _bad: FrameworkPlugin = {
      id: 'x',
      appliesTo: () => true,
      visitor: { language: 'ts' },
    };
    expect(_bad).toBeDefined();
  });
});

describe('ProjectHandle opacity', () => {
  it('cannot be constructed from a plain object literal', () => {
    // @ts-expect-error — plain object does not satisfy the brand
    const _h: ProjectHandle = {};
    expect(_h).toBeDefined();
  });
});

describe('ProjectContext shape', () => {
  it('allows null packageJson', () => {
    const ctx: ProjectContext = { rootDir: '/', packageJson: null, files: [] };
    expect(ctx.packageJson).toBeNull();
  });

  it('allows a parsed packageJson record', () => {
    const ctx: ProjectContext = {
      rootDir: '/',
      packageJson: { name: 'x', dependencies: { express: '^4.0.0' } },
      files: ['index.ts'],
    };
    expect(ctx.packageJson).toMatchObject({ name: 'x' });
  });
});
