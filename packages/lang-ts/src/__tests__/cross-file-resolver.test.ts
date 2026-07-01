import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Node, Project, SyntaxKind, type Identifier } from 'ts-morph';
import {
  resolveIdentifierTypeToDeclaration,
  resolveImportedDeclarations,
  resolveNamespaceImportProperty,
} from '../cross-file-resolver.js';

/**
 * Tests for the type-checker-first / syntactic-walk cross-file
 * Identifier resolution helpers (#200).
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veoable-cross-resolve-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFile(relPath: string, contents: string): void {
  const abs = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function loadProject(extra?: { paths?: Record<string, string[]> }): Project {
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      noEmit: true,
      skipLibCheck: true,
      baseUrl: tmpRoot,
      ...(extra?.paths ? { paths: extra.paths } : {}),
    },
  });
  project.addSourceFilesAtPaths(path.join(tmpRoot, '**/*.ts'));
  return project;
}

function findIdent(project: Project, file: string, text: string): Identifier {
  const sf = project.getSourceFileOrThrow(path.join(tmpRoot, file));
  const ident = sf.getDescendantsOfKind(SyntaxKind.Identifier)
    .find((n) => n.getText() === text);
  if (!ident) throw new Error(`Identifier ${text} not found in ${file}`);
  return ident as Identifier;
}

// ──────────────────────────────────────────────────────────────────────
// resolveIdentifierTypeToDeclaration
// ──────────────────────────────────────────────────────────────────────

describe('resolveIdentifierTypeToDeclaration', () => {
  it('returns the FunctionDeclaration referenced by a same-file Identifier', () => {
    writeFile('a.ts', 'function handler(req: any, res: any) {}\nhandler;');
    const project = loadProject();
    const ident = findIdent(project, 'a.ts', 'handler');
    // The Identifier we want is the *reference* (the second occurrence).
    const refs = project.getSourceFileOrThrow(path.join(tmpRoot, 'a.ts'))
      .getDescendantsOfKind(SyntaxKind.Identifier).filter((n) => n.getText() === 'handler');
    const decl = resolveIdentifierTypeToDeclaration(refs[1] as Identifier, Node.isFunctionDeclaration);
    expect(decl).not.toBeNull();
    expect(Node.isFunctionDeclaration(decl!)).toBe(true);
  });

  it('returns the cross-file FunctionDeclaration referenced by an imported Identifier', () => {
    writeFile('handlers.ts', 'export function listUsers(req: any, res: any) {}');
    writeFile('routes.ts', "import { listUsers } from './handlers';\nexport const ref = listUsers;");
    const project = loadProject();
    const refIdent = findIdent(project, 'routes.ts', 'listUsers');
    // The literal usage in `export const ref = listUsers;` is the
    // 2nd / 3rd occurrence — the import specifier itself counts.
    const occurrences = project.getSourceFileOrThrow(path.join(tmpRoot, 'routes.ts'))
      .getDescendantsOfKind(SyntaxKind.Identifier).filter((n) => n.getText() === 'listUsers');
    // Last occurrence is the value reference.
    const ref = occurrences[occurrences.length - 1] as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, Node.isFunctionDeclaration);
    expect(decl).not.toBeNull();
    expect(Node.isFunctionDeclaration(decl!)).toBe(true);
    expect(decl!.getSourceFile().getFilePath().endsWith('handlers.ts')).toBe(true);
  });

  it('returns the resolved declaration through a path-mapped import', () => {
    // `@app/handlers` => `./src/handlers/index.ts`
    writeFile('src/handlers/index.ts', 'export function listUsers(req: any) {}');
    writeFile('src/routes.ts', "import { listUsers } from '@app/handlers';\nexport const ref = listUsers;");
    const project = loadProject({ paths: { '@app/handlers': ['src/handlers/index.ts'] } });
    const occurrences = project.getSourceFileOrThrow(path.join(tmpRoot, 'src/routes.ts'))
      .getDescendantsOfKind(SyntaxKind.Identifier).filter((n) => n.getText() === 'listUsers');
    const ref = occurrences[occurrences.length - 1] as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, Node.isFunctionDeclaration);
    expect(decl).not.toBeNull();
    expect(decl!.getSourceFile().getFilePath().endsWith('handlers/index.ts')).toBe(true);
  });

  it('returns null when no declaration matches the predicate', () => {
    writeFile('a.ts', 'export const x: number = 1;\nx;');
    const project = loadProject();
    const occurrences = project.getSourceFileOrThrow(path.join(tmpRoot, 'a.ts'))
      .getDescendantsOfKind(SyntaxKind.Identifier).filter((n) => n.getText() === 'x');
    const ref = occurrences[occurrences.length - 1] as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, Node.isFunctionDeclaration);
    expect(decl).toBeNull();
  });

  it('returns null when the identifier has no resolvable type symbol', () => {
    writeFile('a.ts', 'declare const blank: number;\nblank;');
    const project = loadProject();
    const occurrences = project.getSourceFileOrThrow(path.join(tmpRoot, 'a.ts'))
      .getDescendantsOfKind(SyntaxKind.Identifier).filter((n) => n.getText() === 'blank');
    const ref = occurrences[occurrences.length - 1] as Identifier;
    // The type is a primitive number — no symbol on the symbol slot.
    const decl = resolveIdentifierTypeToDeclaration(ref, Node.isFunctionDeclaration);
    expect(decl).toBeNull();
  });

  it('returns a variable-bound arrow declaration cross-file', () => {
    writeFile('handlers.ts', 'export const listUsers = (req: any) => {};');
    writeFile('routes.ts', "import { listUsers } from './handlers';\nexport const ref = listUsers;");
    const project = loadProject();
    const occurrences = project.getSourceFileOrThrow(path.join(tmpRoot, 'routes.ts'))
      .getDescendantsOfKind(SyntaxKind.Identifier).filter((n) => n.getText() === 'listUsers');
    const ref = occurrences[occurrences.length - 1] as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, Node.isVariableDeclaration);
    expect(decl).not.toBeNull();
    expect(decl!.getSourceFile().getFilePath().endsWith('handlers.ts')).toBe(true);
  });

  it('returns a class declaration cross-file', () => {
    writeFile('models.ts', 'export class User { id = 1; }');
    writeFile('app.ts', "import { User } from './models';\nexport const u = new User();");
    const project = loadProject();
    const occurrences = project.getSourceFileOrThrow(path.join(tmpRoot, 'app.ts'))
      .getDescendantsOfKind(SyntaxKind.Identifier).filter((n) => n.getText() === 'User');
    const ref = occurrences[occurrences.length - 1] as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, Node.isClassDeclaration);
    expect(decl).not.toBeNull();
    expect(decl!.getSourceFile().getFilePath().endsWith('models.ts')).toBe(true);
  });

  it('resolves through a re-export chain', () => {
    writeFile('handlers.ts', 'export function inner(): void {}');
    writeFile('public.ts', "export { inner } from './handlers';");
    writeFile('app.ts', "import { inner } from './public';\nexport const ref = inner;");
    const project = loadProject();
    const occurrences = project.getSourceFileOrThrow(path.join(tmpRoot, 'app.ts'))
      .getDescendantsOfKind(SyntaxKind.Identifier).filter((n) => n.getText() === 'inner');
    const ref = occurrences[occurrences.length - 1] as Identifier;
    const decl = resolveIdentifierTypeToDeclaration(ref, Node.isFunctionDeclaration);
    expect(decl).not.toBeNull();
    expect(decl!.getSourceFile().getFilePath().endsWith('handlers.ts')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveImportedDeclarations
// ──────────────────────────────────────────────────────────────────────

describe('resolveImportedDeclarations', () => {
  it('resolves an ImportSpecifier to the target file declarations', () => {
    writeFile('handlers.ts', 'export function listUsers(req: any) {}');
    writeFile('routes.ts', "import { listUsers } from './handlers';\nexport const ref = listUsers;");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'routes.ts'));
    const importDecl = sf.getImportDeclarations()[0];
    const importSpec = importDecl.getNamedImports()[0];
    const decls = resolveImportedDeclarations(importSpec, 'listUsers');
    expect(decls.length).toBeGreaterThanOrEqual(1);
    expect(decls.some((d) => Node.isFunctionDeclaration(d))).toBe(true);
  });

  it('returns [] when target file is not in the project', () => {
    writeFile('routes.ts', "import { listUsers } from 'unresolved-pkg';\nexport const ref = listUsers;");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'routes.ts'));
    const importDecl = sf.getImportDeclarations()[0];
    const importSpec = importDecl.getNamedImports()[0];
    const decls = resolveImportedDeclarations(importSpec, 'listUsers');
    expect(decls).toEqual([]);
  });

  it('returns [] when input is not an import-side node', () => {
    writeFile('a.ts', 'export const x = 1;');
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'a.ts'));
    const variable = sf.getVariableDeclarationOrThrow('x');
    const decls = resolveImportedDeclarations(variable, 'x');
    expect(decls).toEqual([]);
  });

  it('returns [] when the export name is not present in the target file', () => {
    writeFile('handlers.ts', 'export function other() {}');
    writeFile('routes.ts', "import { other } from './handlers';");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'routes.ts'));
    const importDecl = sf.getImportDeclarations()[0];
    const importSpec = importDecl.getNamedImports()[0];
    const decls = resolveImportedDeclarations(importSpec, 'doesNotExist');
    expect(decls).toEqual([]);
  });

  it('resolves default imports (ImportClause)', () => {
    writeFile('handlers.ts', 'export default function listUsers(req: any) {}');
    writeFile('routes.ts', "import listUsers from './handlers';");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'routes.ts'));
    const importClause = sf.getImportDeclarations()[0].getImportClauseOrThrow();
    const decls = resolveImportedDeclarations(importClause, 'default');
    expect(decls.length).toBeGreaterThanOrEqual(1);
    expect(decls.some((d) => Node.isFunctionDeclaration(d))).toBe(true);
  });

  it('resolves namespace imports (NamespaceImport)', () => {
    writeFile('handlers.ts', 'export function listUsers(req: any) {}');
    writeFile('routes.ts', "import * as h from './handlers';");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'routes.ts'));
    const ns = sf.getImportDeclarations()[0].getImportClauseOrThrow().getNamespaceImportOrThrow();
    const decls = resolveImportedDeclarations(ns, 'listUsers');
    expect(decls.length).toBeGreaterThanOrEqual(1);
    expect(decls.some((d) => Node.isFunctionDeclaration(d))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveNamespaceImportProperty (#397)
// ──────────────────────────────────────────────────────────────────────

describe('resolveNamespaceImportProperty', () => {
  it('resolves `schema.users` to the producer file VariableDeclaration', () => {
    writeFile('schema.ts', "export const users = { name: 'users' };");
    writeFile('consumer.ts', "import * as schema from './schema'; const t = schema.users;");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'consumer.ts'));
    const propAccess = sf.getFirstDescendantByKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const decls = resolveNamespaceImportProperty(propAccess);
    expect(decls.length).toBeGreaterThanOrEqual(1);
    expect(decls.some((d) => Node.isVariableDeclaration(d))).toBe(true);
  });

  it('returns [] when receiver is not a namespace import', () => {
    writeFile(
      'consumer.ts',
      "const schema = { users: 'x' }; const t = schema.users;",
    );
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'consumer.ts'));
    // Pick the access in `schema.users` of the const init (the second one;
    // the first is `schema = { users: 'x' }` which has no PropertyAccess).
    const propAccess = sf.getFirstDescendantByKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const decls = resolveNamespaceImportProperty(propAccess);
    expect(decls).toEqual([]);
  });

  it('returns [] when the property is not an export of the namespace', () => {
    writeFile('schema.ts', "export const users = 'u';");
    writeFile('consumer.ts', "import * as schema from './schema'; const t = (schema as any).orders;");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'consumer.ts'));
    // First PropAccess is `schema.orders` (or its as-asserted parent
    // depending on parse, but the inner schema.orders is the access).
    const accesses = sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
    const schemaOrders = accesses.find((a) => a.getNameNode().getText() === 'orders');
    expect(schemaOrders).toBeDefined();
    const decls = resolveNamespaceImportProperty(schemaOrders!);
    expect(decls).toEqual([]);
  });

  it('returns [] for non-PropertyAccessExpression input', () => {
    writeFile('consumer.ts', "const t = 1;");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'consumer.ts'));
    const numLit = sf.getFirstDescendantByKindOrThrow(SyntaxKind.NumericLiteral);
    const decls = resolveNamespaceImportProperty(numLit);
    expect(decls).toEqual([]);
  });

  it('follows a re-exported namespace through a named import (transitive shape)', () => {
    // Mirrors the unkey shape:
    //   schema.ts:  export const users = pgTable('users', {...});
    //   db.ts:      import * as schema from './schema'; export { schema };
    //   consumer:   import { schema } from './db'; tx.insert(schema.users)
    writeFile('schema.ts', "export const users = { name: 'users' };");
    writeFile('db.ts', "import * as schema from './schema'; export { schema };");
    writeFile('consumer.ts', "import { schema } from './db'; const t = schema.users;");
    const project = loadProject();
    const sf = project.getSourceFileOrThrow(path.join(tmpRoot, 'consumer.ts'));
    const propAccess = sf.getFirstDescendantByKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const decls = resolveNamespaceImportProperty(propAccess);
    expect(decls.length).toBeGreaterThanOrEqual(1);
    expect(decls.some((d) => Node.isVariableDeclaration(d))).toBe(true);
  });
});
