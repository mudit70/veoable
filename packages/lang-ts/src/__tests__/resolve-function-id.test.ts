import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project, type Identifier } from 'ts-morph';
import { idFor } from '@veoable/schema';
import { resolveIdentifierTypeToDeclaration } from '../cross-file-resolver.js';
import { resolveFunctionDefinitionIdFromDecl } from '../resolve-function-id.js';
import type { TsVisitContext } from '../framework-visitor.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veoable-resolve-fn-id-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFile(relPath: string, contents: string): void {
  const abs = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function loadProject(): Project {
  const project = new Project({
    compilerOptions: { target: 99, module: 99, moduleResolution: 100, allowJs: true },
  });
  project.addSourceFilesAtPaths(path.join(tmpRoot, '**/*.{ts,tsx}'));
  return project;
}

function makeCtx(project: Project, callerRelPath: string): TsVisitContext {
  const repository = 'fixture-repo';
  const callerSourceFileId = idFor.sourceFile({ repository, filePath: callerRelPath });
  return {
    sourceFile: {
      nodeType: 'SourceFile',
      id: callerSourceFileId,
      filePath: callerRelPath,
      repository,
      language: 'ts',
      framework: null,
    },
    enclosingFunction: undefined,
    project,
    rootDir: tmpRoot,
    repository,
    emitNode: () => {},
    emitEdge: () => {},
  };
}

describe('resolveFunctionDefinitionIdFromDecl (#263)', () => {
  it('resolves a same-file FunctionDeclaration to the matching FunctionDefinition.id', () => {
    writeFile('a.ts', `
      function handler(req: any) {}
      const ref: any = handler;
    `);
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'a.ts'));
    const ref = sf.getVariableDeclarationOrThrow('ref').getInitializerOrThrow() as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, () => true)!;
    expect(decl).toBeDefined();

    const ctx = makeCtx(project, 'a.ts');
    const id = resolveFunctionDefinitionIdFromDecl(decl, ctx);
    expect(id).not.toBeNull();
    // Compare against the canonical id lang-ts would emit for that decl.
    const expected = idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name: 'handler',
      sourceLine: decl.getStartLineNumber(),
    });
    expect(id).toBe(expected);
  });

  it('resolves a CROSS-FILE FunctionDeclaration to a deterministic id', () => {
    writeFile('handlers.ts', 'export function handler(req: any) {}');
    writeFile('caller.ts', `
      import { handler } from './handlers';
      const ref: any = handler;
    `);
    const project = loadProject();
    const callerSf = project.getSourceFileOrThrow(path.join(tmpRoot, 'caller.ts'));
    const ref = callerSf.getVariableDeclarationOrThrow('ref').getInitializerOrThrow() as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, () => true)!;
    expect(decl).toBeDefined();
    expect(decl.getSourceFile().getFilePath()).toBe(path.join(tmpRoot, 'handlers.ts'));

    const ctx = makeCtx(project, 'caller.ts');
    const id = resolveFunctionDefinitionIdFromDecl(decl, ctx);
    expect(id).not.toBeNull();
    // The id MUST reference the OTHER file's source-file id, computed
    // identically to how lang-ts emits the FunctionDefinition during
    // its extract pass on handlers.ts.
    const targetSourceFileId = idFor.sourceFile({
      repository: 'fixture-repo',
      filePath: 'handlers.ts',
    });
    const expected = idFor.functionDefinition({
      sourceFileId: targetSourceFileId,
      name: 'handler',
      sourceLine: 1,
    });
    expect(id).toBe(expected);
  });

  it('returns null for a declaration outside the project root', () => {
    writeFile('a.ts', `
      import { foo } from 'some-package';
      const ref: any = foo;
    `);
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'a.ts'));
    const ref = sf.getVariableDeclarationOrThrow('ref').getInitializerOrThrow() as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, () => true);
    // Resolution may fail entirely (no module installed) or return a
    // node from an external path. Either way the helper returns null.
    if (decl) {
      const ctx = makeCtx(project, 'a.ts');
      const id = resolveFunctionDefinitionIdFromDecl(decl, ctx);
      expect(id).toBeNull();
    }
  });

  it('resolves a cross-file variable-bound arrow', () => {
    writeFile('handlers.ts', 'export const handler = async (req: any) => {};');
    writeFile('caller.ts', `
      import { handler } from './handlers';
      const ref: any = handler;
    `);
    const project = loadProject();
    const callerSf = project.getSourceFileOrThrow(path.join(tmpRoot, 'caller.ts'));
    const ref = callerSf.getVariableDeclarationOrThrow('ref').getInitializerOrThrow() as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, () => true)!;
    expect(decl).toBeDefined();

    const ctx = makeCtx(project, 'caller.ts');
    const id = resolveFunctionDefinitionIdFromDecl(decl, ctx);
    expect(id).not.toBeNull();
  });
});
