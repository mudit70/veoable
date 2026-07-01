import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Node, Project } from 'ts-morph';
import { findUniqueExportedDeclaration } from '../find-exported-declaration.js';

/**
 * Tests for the name-based exported-declaration lookup helper (#195).
 *
 * The helper is the last-resort fallback for cross-file Identifier
 * resolution when both the type checker and ImportDeclaration walking
 * have failed (typically because workspace metadata wasn't declared
 * and `compilerOptions.paths` weren't synthesized).
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-find-exp-'));
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
    compilerOptions: { allowJs: true, noEmit: true, skipLibCheck: true },
  });
  project.addSourceFilesAtPaths(path.join(tmpRoot, '**/*.ts'));
  return project;
}

describe('findUniqueExportedDeclaration', () => {
  it('finds a class exported from any file in the project', () => {
    writeFile('a.ts', 'export class Foo { x = 1; }');
    writeFile('b.ts', 'export const unrelated = 42;');
    const project = loadProject();
    const decl = findUniqueExportedDeclaration(project, 'Foo', (d) =>
      Node.isClassDeclaration(d) || Node.isClassExpression(d),
    );
    expect(decl).not.toBeNull();
    expect(Node.isClassDeclaration(decl!)).toBe(true);
  });

  it('returns null when no matching declaration exists', () => {
    writeFile('a.ts', 'export const Foo = 1;');
    const project = loadProject();
    const decl = findUniqueExportedDeclaration(project, 'Foo', (d) =>
      Node.isClassDeclaration(d) || Node.isClassExpression(d),
    );
    expect(decl).toBeNull();
  });

  it('returns null when the name is not exported anywhere', () => {
    writeFile('a.ts', 'class Foo {}'); // not exported
    const project = loadProject();
    const decl = findUniqueExportedDeclaration(project, 'Foo', (d) =>
      Node.isClassDeclaration(d) || Node.isClassExpression(d),
    );
    expect(decl).toBeNull();
  });

  it('refuses to pick when two files export the same name (ambiguous)', () => {
    writeFile('a.ts', 'export class Foo {}');
    writeFile('b.ts', 'export class Foo {}');
    const project = loadProject();
    const decl = findUniqueExportedDeclaration(project, 'Foo', (d) =>
      Node.isClassDeclaration(d) || Node.isClassExpression(d),
    );
    expect(decl).toBeNull();
  });

  it('finds a function declaration when the predicate matches', () => {
    writeFile('a.ts', 'export function helper() { return 1; }');
    const project = loadProject();
    const decl = findUniqueExportedDeclaration(project, 'helper', Node.isFunctionDeclaration);
    expect(decl).not.toBeNull();
    expect(Node.isFunctionDeclaration(decl!)).toBe(true);
  });

  it('skips declarations that do not match the predicate even if the name matches', () => {
    writeFile('a.ts', 'export const Foo = (x: number) => x + 1;');
    const project = loadProject();
    const decl = findUniqueExportedDeclaration(project, 'Foo', (d) =>
      Node.isClassDeclaration(d) || Node.isClassExpression(d),
    );
    // `Foo` is exported but as a VariableDeclaration with arrow init —
    // not a class. Predicate filters it out.
    expect(decl).toBeNull();
  });

  it('handles a project with zero source files', () => {
    const project = loadProject();
    const decl = findUniqueExportedDeclaration(project, 'Foo', () => true);
    expect(decl).toBeNull();
  });
});
