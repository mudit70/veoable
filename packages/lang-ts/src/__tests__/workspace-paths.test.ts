import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsLanguagePlugin } from '../ts-language-plugin.js';
import { unwrapHandle } from '../project-handle.js';

/**
 * Integration test for #195's compiler-paths injection. Builds a
 * minimal Layout-A-style monorepo (declared workspace, scoped subpackage
 * names) and verifies that, when `loadProject` receives synthesized
 * `compilerPaths`, ts-morph can resolve a cross-package alias import
 * (`@scope/server/foo`) to the correct source file.
 *
 * Without `compilerPaths`, the equivalent import would fail to resolve
 * because no `node_modules/@scope/server` symlink exists in the test
 * setup — exactly the gap #195's `discoverWorkspacePackages` +
 * `synthesizeWorkspaceCompilerPaths` close.
 */

let tmpRoot: string;

function writeFile(rel: string, contents: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adorable-ws-paths-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('compilerPaths injection (#195)', () => {
  it('without compilerPaths, ts-morph cannot resolve a workspace-aliased import', async () => {
    // Minimal monorepo with two packages, the consumer importing the
    // producer via `@scope/server/foo`.
    writeFile('apps/web/src/index.ts', `
import { Foo } from '@scope/server/foo';
export const x: Foo = { id: 1 };
`);
    writeFile('packages/server/foo.ts', `
export interface Foo { id: number }
`);

    const ts = new TsLanguagePlugin();
    const handle = await ts.loadProject({ rootDir: tmpRoot });
    // Both files are in the project, but the import in apps/web/src/index.ts
    // can't resolve to packages/server/foo.ts via the @scope/server alias
    // because no compilerPaths were supplied. The import resolves to
    // null in ts-morph's view of the world.
    const internal = unwrapHandle(handle);
    const consumer = internal.project.getSourceFiles().find((s) => s.getFilePath().endsWith('apps/web/src/index.ts'))!;
    const importDecls = consumer.getImportDeclarations();
    expect(importDecls).toHaveLength(1);
    expect(importDecls[0]!.getModuleSpecifierSourceFile()).toBeUndefined();
  });

  it('with compilerPaths, ts-morph resolves a workspace-aliased import to the producer file', async () => {
    writeFile('apps/web/src/index.ts', `
import { Foo } from '@scope/server/foo';
export const x: Foo = { id: 1 };
`);
    writeFile('packages/server/foo.ts', `
export interface Foo { id: number }
`);

    const compilerPaths = {
      '@scope/server': [path.join(tmpRoot, 'packages/server')],
      '@scope/server/*': [path.join(tmpRoot, 'packages/server', '*')],
    };

    const ts = new TsLanguagePlugin();
    const handle = await ts.loadProject({ rootDir: tmpRoot, compilerPaths });
    const internal = unwrapHandle(handle);
    const consumer = internal.project.getSourceFiles().find((s) => s.getFilePath().endsWith('apps/web/src/index.ts'))!;
    const importDecls = consumer.getImportDeclarations();
    expect(importDecls).toHaveLength(1);
    const target = importDecls[0]!.getModuleSpecifierSourceFile();
    expect(target).toBeDefined();
    expect(target!.getFilePath().endsWith('packages/server/foo.ts')).toBe(true);
  });

  it('user-declared tsconfig paths win on key collision with synthesized paths', async () => {
    // tsconfig with explicit paths pointing at a different location.
    // The synthesized workspace path for the same key should not override.
    writeFile('tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        baseUrl: '.',
        paths: {
          '@scope/server/*': ['custom-location/*'],
        },
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['**/*.ts'],
    }, null, 2));
    writeFile('custom-location/foo.ts', `export interface Foo { id: number }`);
    writeFile('packages/server/foo.ts', `export class WrongTarget {}`); // would-be synthesized target
    writeFile('apps/web/src/index.ts', `
import { Foo } from '@scope/server/foo';
export const x: Foo = { id: 1 };
`);

    const compilerPaths = {
      '@scope/server/*': [path.join(tmpRoot, 'packages/server', '*')],
    };

    const ts = new TsLanguagePlugin();
    const handle = await ts.loadProject({ rootDir: tmpRoot, compilerPaths });
    const internal = unwrapHandle(handle);
    const consumer = internal.project.getSourceFiles().find((s) => s.getFilePath().endsWith('apps/web/src/index.ts'))!;
    const target = consumer.getImportDeclarations()[0]!.getModuleSpecifierSourceFile();
    expect(target).toBeDefined();
    // Tsconfig-declared path wins — resolves to custom-location/foo.ts,
    // NOT packages/server/foo.ts.
    expect(target!.getFilePath().endsWith('custom-location/foo.ts')).toBe(true);
  });

  // #312 — combined real-world scenario: path-aliased import +
  // singleton-with-fallback PrismaClient + no baseUrl in tsconfig.
  // Mirrors what papermark / documenso actually look like. End-to-end
  // assertion that the import target is reachable AND a downstream
  // resolver sees the expected shape.
  it('Next.js + Prisma combined scenario: path alias resolves AND singleton pattern can be traversed', async () => {
    writeFile('tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        // No baseUrl — matches Next.js default.
        paths: {
          '@/*': ['./*'],
        },
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['**/*.ts'],
    }, null, 2));
    // Singleton pattern: `const prisma = global.prisma || new PrismaClient()`
    writeFile('lib/prisma.ts', `
class PrismaClient {
  user = { findMany: () => [] };
}
declare const globalThisPrisma: PrismaClient | undefined;
const prisma = globalThisPrisma || new PrismaClient();
export default prisma;
`);
    writeFile('app/users/route.ts', `
import prisma from '@/lib/prisma';
export async function GET() {
  return prisma.user.findMany();
}
`);

    const ts = new TsLanguagePlugin();
    const handle = await ts.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const consumer = internal.project.getSourceFiles().find((s) => s.getFilePath().endsWith('app/users/route.ts'))!;
    const importDecl = consumer.getImportDeclarations()[0]!;
    // Assertion 1: the alias resolves cross-file (the lang-ts baseUrl fix).
    const target = importDecl.getModuleSpecifierSourceFile();
    expect(target).toBeDefined();
    expect(target!.getFilePath().endsWith('lib/prisma.ts')).toBe(true);

    // Assertion 2: the import target's default-export VariableDeclaration
    // exists and its initializer is a `||` BinaryExpression — the shape
    // the framework-prisma resolver now unwraps. Pin the shape so a
    // future change to the unwrap logic can be detected upstream.
    const exportedDecls = target!.getExportedDeclarations().get('default');
    expect(exportedDecls).toBeDefined();
    expect(exportedDecls!.length).toBeGreaterThan(0);
  });

  // #312 — Next.js-style tsconfig with `paths` but NO `baseUrl`.
  // Pre-fix, ts-morph couldn't resolve the alias (returned null),
  // silently breaking cross-file resolution in framework-prisma /
  // framework-fetch / framework-react. This is the regression that
  // PR #309 patched with a name-regex fallback.
  it('resolves path-aliased imports when tsconfig declares paths but not baseUrl', async () => {
    writeFile('tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        // NOTE: no baseUrl — this is the Next.js default.
        paths: {
          '@/*': ['./*'],
        },
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['**/*.ts'],
    }, null, 2));
    writeFile('lib/prisma.ts', `
export class PrismaClient {
  user = { findMany: () => [] };
}
const prisma = new PrismaClient();
export default prisma;
`);
    writeFile('pages/index.ts', `
import prisma from '@/lib/prisma';
export async function listUsers() {
  return prisma.user.findMany();
}
`);

    const ts = new TsLanguagePlugin();
    const handle = await ts.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const consumer = internal.project.getSourceFiles().find((s) => s.getFilePath().endsWith('pages/index.ts'))!;
    const target = consumer.getImportDeclarations()[0]!.getModuleSpecifierSourceFile();
    expect(target).toBeDefined();
    expect(target!.getFilePath().endsWith('lib/prisma.ts')).toBe(true);
  });

  // #338 / #325 — when compilerPaths has more than MAX_EXTRA_PATH_TARGETS
  // unique targets, the loader caps and emits an onWarning. The
  // default cap is 250 (#325 raised it from 30 after dub, cal.com,
  // and typebot.io all hit the prior cap on the @<scope>/prisma
  // package). The cap is overridable via env so this test pins
  // both the warning shape AND the override mechanism without
  // generating 250+ fixture packages.
  it('emits an onWarning when the path-target loader cap is hit', async () => {
    const previousOverride = process.env.ADORABLE_MAX_EXTRA_PATH_TARGETS;
    process.env.ADORABLE_MAX_EXTRA_PATH_TARGETS = '30';
    try {
      // Build 35 sibling packages so the (override-lowered) loader
      // caps at 30.
      const compilerPaths: Record<string, string[]> = {};
      for (let i = 0; i < 35; i++) {
        const pkgDir = path.join(tmpRoot, `sibling-${i}`);
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(path.join(pkgDir, 'index.ts'), `export const x${i} = ${i};\n`);
        compilerPaths[`@scope/sibling-${i}`] = [pkgDir];
      }
      fs.mkdirSync(path.join(tmpRoot, 'apps/web/src'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'apps/web/src/index.ts'), 'export {};\n');

      const warnings: string[] = [];
      const ts = new TsLanguagePlugin();
      await ts.loadProject({
        rootDir: path.join(tmpRoot, 'apps/web'),
        compilerPaths,
        onWarning: (msg) => warnings.push(msg),
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/hit cap \(30\)/);
      expect(warnings[0]).toMatch(/all 35 unique path targets/);
    } finally {
      if (previousOverride === undefined) delete process.env.ADORABLE_MAX_EXTRA_PATH_TARGETS;
      else process.env.ADORABLE_MAX_EXTRA_PATH_TARGETS = previousOverride;
    }
  });

  // #325 — the new default cap is 250. 35 sibling packages MUST NOT
  // trigger the warning under the default cap. Pins that the raise
  // actually shipped (and protects against a regression to a low
  // cap that re-introduces the dub/cal.com/typebot.io misses).
  it('does NOT emit onWarning at 35 sibling packages with the default cap of 250', async () => {
    const compilerPaths: Record<string, string[]> = {};
    for (let i = 0; i < 35; i++) {
      const pkgDir = path.join(tmpRoot, `default-sib-${i}`);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'index.ts'), `export const y${i} = ${i};\n`);
      compilerPaths[`@scope/default-sib-${i}`] = [pkgDir];
    }
    fs.mkdirSync(path.join(tmpRoot, 'apps/web/src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'apps/web/src/index.ts'), 'export {};\n');

    const warnings: string[] = [];
    const ts = new TsLanguagePlugin();
    await ts.loadProject({
      rootDir: path.join(tmpRoot, 'apps/web'),
      compilerPaths,
      onWarning: (msg) => warnings.push(msg),
    });
    expect(warnings.length).toBe(0);
  });

  it('does not emit onWarning when path-target count is within the cap', async () => {
    const compilerPaths: Record<string, string[]> = {};
    for (let i = 0; i < 5; i++) {
      const pkgDir = path.join(tmpRoot, `sib-${i}`);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'index.ts'), 'export {};\n');
      compilerPaths[`@scope/sib-${i}`] = [pkgDir];
    }
    fs.mkdirSync(path.join(tmpRoot, 'apps/web/src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'apps/web/src/index.ts'), 'export {};\n');

    const warnings: string[] = [];
    const ts = new TsLanguagePlugin();
    await ts.loadProject({
      rootDir: path.join(tmpRoot, 'apps/web'),
      compilerPaths,
      onWarning: (msg) => warnings.push(msg),
    });
    expect(warnings.length).toBe(0);
  });
});
