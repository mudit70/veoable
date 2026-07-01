import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TsLanguagePlugin } from '../index.js';
import { unwrapHandle } from '../project-handle.js';

/**
 * #529 — monorepos with per-package tsconfigs were silently producing
 * empty graphs because lang-ts only loaded the files matched by the
 * root tsconfig's `include`. The fix: always supplement with a
 * rootDir-wide `addSourceFilesAtPaths` sweep so subpackage files end
 * up in the same Project.
 */

let tmpRoot: string;

function write(rel: string, content: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'langts-monorepo-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('monorepo loader (#529)', () => {
  it('loads subpackage TS files even when root tsconfig excludes them', async () => {
    // Root tsconfig that ONLY includes the root src/ — emulates the
    // typebot.io / cal.com shape where each app and package has its
    // own tsconfig and the root one delegates via `references`.
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'esnext', target: 'esnext' },
        include: ['src/**/*'],
      }),
    );
    write('src/root.ts', 'export const root = 1;\n');
    write('apps/builder/tsconfig.json', JSON.stringify({ extends: '../../tsconfig.json' }));
    write('apps/builder/src/page.tsx', 'export const Page = () => null;\n');
    write('apps/viewer/src/handler.ts', 'export const handler = async () => 1;\n');
    write('packages/lib/src/util.ts', 'export const util = 1;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => path.relative(tmpRoot, sf.getFilePath()))
      .map((p) => p.split(path.sep).join('/'));

    expect(filePaths).toContain('src/root.ts');
    expect(filePaths).toContain('apps/builder/src/page.tsx');
    expect(filePaths).toContain('apps/viewer/src/handler.ts');
    expect(filePaths).toContain('packages/lib/src/util.ts');
  });

  it('does not double-load files already in the root tsconfig include', async () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { module: 'esnext' }, include: ['src/**/*'] }),
    );
    write('src/a.ts', 'export const a = 1;\n');
    write('src/b.ts', 'export const b = 1;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => sf.getFilePath());

    const aCount = filePaths.filter((p) => p.endsWith('/src/a.ts')).length;
    const bCount = filePaths.filter((p) => p.endsWith('/src/b.ts')).length;
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
  });

  it('honors orchestrator-supplied opts.include and opts.exclude in the sweep step', async () => {
    // The orchestrator contract: when `include` / `exclude` are
    // passed in `ProjectOptions`, the supplemental sweep uses them
    // instead of the defaults. (The tsconfig load is unchanged —
    // tsconfig.json's own include/exclude govern that step.)
    // No tsconfig here so we isolate the sweep behavior.
    write('apps/keep/page.ts', 'export const k = 1;\n');
    write('apps/skip/page.ts', 'export const s = 1;\n');
    write('apps/extra/util.ts', 'export const e = 1;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({
      rootDir: tmpRoot,
      include: [
        path.join(tmpRoot, 'apps/keep/**/*.ts'),
        path.join(tmpRoot, 'apps/extra/**/*.ts'),
      ],
      exclude: [path.join(tmpRoot, 'apps/skip/**')],
    });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => path.relative(tmpRoot, sf.getFilePath()))
      .map((p) => p.split(path.sep).join('/'));

    expect(filePaths).toContain('apps/keep/page.ts');
    expect(filePaths).toContain('apps/extra/util.ts');
    expect(filePaths).not.toContain('apps/skip/page.ts');
  });

  it('does not double-load subpackage files when a per-app tsconfig exists alongside them', async () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'esnext' },
        references: [{ path: './apps/builder' }],
      }),
    );
    write(
      'apps/builder/tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'esnext', composite: true },
        include: ['src/**/*'],
      }),
    );
    write('apps/builder/src/page.tsx', 'export const Page = () => null;\n');
    write('apps/builder/src/util.ts', 'export const u = 1;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project.getSourceFiles().map((sf) => sf.getFilePath());

    const pageCount = filePaths.filter((p) => p.endsWith('/apps/builder/src/page.tsx')).length;
    const utilCount = filePaths.filter((p) => p.endsWith('/apps/builder/src/util.ts')).length;
    expect(pageCount).toBe(1);
    expect(utilCount).toBe(1);
  });

  it('skips the sweep when root tsconfig already references all subpackage tsconfigs (perf gate)', async () => {
    // cal.com / single-tsconfig shape: root tsconfig either covers
    // every file (no subpackage tsconfig) OR explicitly `references`
    // every subpackage tsconfig. In both cases ts-morph already
    // resolves what we need — the sweep would only add cost.
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'esnext' },
        include: ['src/**/*'],
        references: [{ path: './apps/builder' }],
      }),
    );
    write('src/root.ts', 'export const root = 1;\n');
    // Subpackage with its own tsconfig, but the root references it.
    write('apps/builder/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext' } }));
    write('apps/builder/src/page.tsx', 'export const Page = () => null;\n');
    // A scratch file under apps/builder that the root tsconfig does
    // NOT include and ts-morph's reference walking does NOT pull in
    // (ts-morph doesn't transitively load referenced tsconfig's files).
    // This file SHOULD be skipped when the gate triggers — that's the
    // perf tradeoff we accept for cal.com-class repos.

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => path.relative(tmpRoot, sf.getFilePath()))
      .map((p) => p.split(path.sep).join('/'));

    expect(filePaths).toContain('src/root.ts');
    // The gate fires: builder/src/page.tsx is NOT added by the sweep
    // because the root references the subpackage tsconfig.
    expect(filePaths).not.toContain('apps/builder/src/page.tsx');
  });

  it('treats `references: [{ path: "./apps/x/tsconfig.json" }]` (file form) as covered', async () => {
    // TypeScript supports `references: [{ path: "./subdir/tsconfig.json" }]`
    // as an alternative to `./subdir`. The gate must accept both.
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'esnext' },
        include: ['src/**/*'],
        references: [{ path: './apps/builder/tsconfig.json' }],
      }),
    );
    write('src/root.ts', 'export const r = 1;\n');
    write('apps/builder/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext' } }));
    write('apps/builder/src/page.tsx', 'export const Page = () => null;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => path.relative(tmpRoot, sf.getFilePath()))
      .map((p) => p.split(path.sep).join('/'));
    // The gate fires: builder/src/page.tsx is NOT swept in.
    expect(filePaths).not.toContain('apps/builder/src/page.tsx');
  });

  it('honors `libs/` as an Nx-default subpackage layout', async () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { module: 'esnext' }, include: ['src/**/*'] }),
    );
    write('src/root.ts', 'export const r = 1;\n');
    write('libs/shared/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext' } }));
    write('libs/shared/src/util.ts', 'export const u = 1;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => path.relative(tmpRoot, sf.getFilePath()))
      .map((p) => p.split(path.sep).join('/'));
    expect(filePaths).toContain('libs/shared/src/util.ts');
  });

  it('tolerates JSONC line comments and trailing commas in the root tsconfig', async () => {
    // TypeScript's parseConfigFileTextToJson handles both — a naive
    // JSON.parse + regex strip would clobber `https://` inside string
    // values or choke on trailing commas.
    const tsconfigRaw = `{
      // Production root tsconfig
      "compilerOptions": {
        "module": "esnext",
        "types": ["./types"]  /* extra types */
      },
      "include": ["src/**/*"],
      "references": [
        { "path": "./apps/builder" },  // trailing comma below is JSONC-legal
      ],
    }`;
    write('tsconfig.json', tsconfigRaw);
    write('src/root.ts', 'export const r = 1;\n');
    write('apps/builder/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext' } }));
    write('apps/builder/src/page.tsx', 'export const Page = () => null;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => path.relative(tmpRoot, sf.getFilePath()))
      .map((p) => p.split(path.sep).join('/'));
    expect(filePaths).toContain('src/root.ts');
    // References was parseable → gate triggers → page.tsx NOT swept.
    expect(filePaths).not.toContain('apps/builder/src/page.tsx');
  });

  it('runs the sweep when a subpackage tsconfig is NOT referenced (the #529 case)', async () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'esnext' },
        include: ['src/**/*'],
        // No `references` array — typebot.io-class shape.
      }),
    );
    write('src/root.ts', 'export const root = 1;\n');
    write('apps/builder/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext' } }));
    write('apps/builder/src/page.tsx', 'export const Page = () => null;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => path.relative(tmpRoot, sf.getFilePath()))
      .map((p) => p.split(path.sep).join('/'));

    expect(filePaths).toContain('src/root.ts');
    expect(filePaths).toContain('apps/builder/src/page.tsx');
  });

  it('respects node_modules exclusion when sweeping subpackages', async () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext' } }));
    write('src/app.ts', 'export const app = 1;\n');
    // A node_modules dropping inside a subpackage — should NOT be loaded.
    write('packages/foo/node_modules/pkg/index.ts', 'export const leaked = 1;\n');

    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: tmpRoot });
    const internal = unwrapHandle(handle);
    const filePaths = internal.project
      .getSourceFiles()
      .map((sf) => path.relative(tmpRoot, sf.getFilePath()))
      .map((p) => p.split(path.sep).join('/'));

    expect(filePaths).toContain('src/app.ts');
    expect(filePaths.some((p) => p.includes('node_modules'))).toBe(false);
  });
});
