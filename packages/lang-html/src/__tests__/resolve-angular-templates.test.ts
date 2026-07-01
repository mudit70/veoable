import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { idFor, type FunctionDefinition, type SourceFile } from '@veoable/schema';
import { makeBatchMeta } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { resolveAngularTemplates } from '../resolve-angular-templates.js';

const repo = 'ng-resolve-test';

let store: SQLiteCanonicalGraphStore;
let rootDir: string;

beforeEach(() => {
  store = new SQLiteCanonicalGraphStore(':memory:');
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-resolve-'));
});

afterEach(() => {
  store.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/** Write a file to the rootDir and seed its SourceFile in the graph. */
function seedFile(relPath: string, language: string, content: string): SourceFile {
  const abs = path.join(rootDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  const sf: SourceFile = {
    nodeType: 'SourceFile',
    id: idFor.sourceFile({ repository: repo, filePath: relPath }),
    filePath: relPath,
    repository: repo,
    language,
    framework: null,
  };
  store.commit({ nodes: [sf], edges: [] }, makeBatchMeta('test'));
  return sf;
}

/** Seed a per-process synthetic fn in an HTML SourceFile. */
function seedHtmlPerProcessFn(sf: SourceFile, name: string, snippet: string, line: number): FunctionDefinition {
  const fn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: sf.id, name, sourceLine: line }),
    name,
    sourceFileId: sf.id,
    sourceLine: line,
    parameters: [],
    returnType: null,
    isExported: false,
    isAsync: false,
    evidence: { filePath: sf.filePath, lineStart: line, lineEnd: line, snippet, confidence: 'exact' },
  };
  store.commit({ nodes: [fn], edges: [] }, makeBatchMeta('test'));
  return fn;
}

/** Seed a class-method FunctionDefinition (e.g., `LoginComponent.onSubmit`). */
function seedClassMethod(sf: SourceFile, name: string, line = 10): FunctionDefinition {
  const fn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: sf.id, name, sourceLine: line }),
    name,
    sourceFileId: sf.id,
    sourceLine: line,
    parameters: [],
    returnType: null,
    isExported: false,
    isAsync: false,
  };
  store.commit({ nodes: [fn], edges: [] }, makeBatchMeta('test'));
  return fn;
}

describe('resolveAngularTemplates', () => {
  it('emits CALLS_FUNCTION from per-process fn to ClassName.method via templateUrl mapping', () => {
    seedFile('src/login.component.ts', 'ts', `
      import { Component } from '@angular/core';
      @Component({
        selector: 'app-login',
        templateUrl: './login.component.html',
      })
      export class LoginComponent {
        onSubmit() {}
        trackClick() {}
      }
    `);
    const tpl = seedFile('src/login.component.html', 'html', '<button (click)="trackClick()"></button>');
    const handler = seedHtmlPerProcessFn(tpl, '_button_click_L1_(click)', `(click)="trackClick()"`, 1);
    const tsSf = store.findNodes('SourceFile').find((s) => s.filePath.endsWith('.ts'))!;
    const target = seedClassMethod(tsSf, 'LoginComponent.trackClick');

    const batch = resolveAngularTemplates(store, rootDir);
    expect(batch.edges).toHaveLength(1);
    expect(batch.edges[0].from).toBe(handler.id);
    expect(batch.edges[0].to).toBe(target.id);
  });

  it('handles abstract / decorator-only / no-export class declarations', () => {
    seedFile('src/dashboard.component.ts', 'ts', `
      @Component({ templateUrl: './dashboard.component.html' })
      abstract class DashboardComponent {
        loadData() {}
      }
    `);
    const tpl = seedFile('src/dashboard.component.html', 'html', '');
    const handler = seedHtmlPerProcessFn(tpl, '_button_click_L1_(click)', `(click)="loadData()"`, 1);
    const tsSf = store.findNodes('SourceFile').find((s) => s.filePath.endsWith('.ts'))!;
    const target = seedClassMethod(tsSf, 'DashboardComponent.loadData');

    const batch = resolveAngularTemplates(store, rootDir);
    expect(batch.edges).toHaveLength(1);
    expect(batch.edges[0].to).toBe(target.id);
  });

  it('emits one edge per call name when the snippet has multiple', () => {
    seedFile('src/users.component.ts', 'ts', `
      @Component({ templateUrl: './users.component.html' })
      export class UsersComponent {
        track() {}
        save() {}
      }
    `);
    const tpl = seedFile('src/users.component.html', 'html', '');
    seedHtmlPerProcessFn(tpl, '_button_click_L1_(click)', `(click)="track(); save()"`, 1);
    const tsSf = store.findNodes('SourceFile').find((s) => s.filePath.endsWith('.ts'))!;
    seedClassMethod(tsSf, 'UsersComponent.track');
    seedClassMethod(tsSf, 'UsersComponent.save');

    const batch = resolveAngularTemplates(store, rootDir);
    expect(batch.edges).toHaveLength(2);
  });

  it('skips templates with no matching @Component decorator', () => {
    seedFile('src/orphan.html', 'html', '');
    const tpl = store.findNodes('SourceFile').find((s) => s.filePath.endsWith('.html'))!;
    seedHtmlPerProcessFn(tpl, '_button_click_L1_(click)', `(click)="doStuff()"`, 1);

    const batch = resolveAngularTemplates(store, rootDir);
    expect(batch.edges).toHaveLength(0);
  });

  it('does NOT emit edges when the class method has a different name', () => {
    seedFile('src/x.component.ts', 'ts', `
      @Component({ templateUrl: './x.component.html' })
      class XComponent { somethingElse() {} }
    `);
    const tpl = seedFile('src/x.component.html', 'html', '');
    seedHtmlPerProcessFn(tpl, '_button_click_L1_(click)', `(click)="trackClick()"`, 1);
    const tsSf = store.findNodes('SourceFile').find((s) => s.filePath.endsWith('.ts'))!;
    seedClassMethod(tsSf, 'XComponent.somethingElse');

    const batch = resolveAngularTemplates(store, rootDir);
    expect(batch.edges).toHaveLength(0);
  });

  it('skips templateUrl that points outside the graph', () => {
    seedFile('src/missing.component.ts', 'ts', `
      @Component({ templateUrl: './nope.component.html' })
      class MissingComponent { hi() {} }
    `);
    // No HTML file seeded.
    const batch = resolveAngularTemplates(store, rootDir);
    expect(batch.edges).toHaveLength(0);
  });

  it('handles inline `template:` (NOT templateUrl) by ignoring it — out of scope', () => {
    seedFile('src/inline.component.ts', 'ts', `
      @Component({ template: '<button (click)="x()"></button>' })
      class InlineComponent { x() {} }
    `);
    // No external template file. The decorator has no templateUrl, so
    // resolveAngularTemplates does nothing.
    const batch = resolveAngularTemplates(store, rootDir);
    expect(batch.edges).toHaveLength(0);
  });

  it('handles multiple components in one file', () => {
    seedFile('src/multi.ts', 'ts', `
      @Component({ templateUrl: './a.html' }) class AComponent { aMethod() {} }
      @Component({ templateUrl: './b.html' }) class BComponent { bMethod() {} }
    `);
    const aTpl = seedFile('src/a.html', 'html', '');
    const bTpl = seedFile('src/b.html', 'html', '');
    seedHtmlPerProcessFn(aTpl, '_button_click_L1_(click)', `(click)="aMethod()"`, 1);
    seedHtmlPerProcessFn(bTpl, '_button_click_L1_(click)', `(click)="bMethod()"`, 1);
    const tsSf = store.findNodes('SourceFile').find((s) => s.filePath.endsWith('multi.ts'))!;
    seedClassMethod(tsSf, 'AComponent.aMethod');
    seedClassMethod(tsSf, 'BComponent.bMethod');

    const batch = resolveAngularTemplates(store, rootDir);
    expect(batch.edges).toHaveLength(2);
  });

  it('does not emit when call references a method on a different component', () => {
    // A's template references `bMethod` which only exists on B. We don't
    // resolve cross-component references.
    seedFile('src/a.component.ts', 'ts', `
      @Component({ templateUrl: './a.component.html' })
      class AComponent { aMethod() {} }
    `);
    seedFile('src/b.component.ts', 'ts', `
      @Component({ templateUrl: './b.component.html' })
      class BComponent { bMethod() {} }
    `);
    const aTpl = seedFile('src/a.component.html', 'html', '');
    seedFile('src/b.component.html', 'html', '');
    seedHtmlPerProcessFn(aTpl, '_button_click_L1_(click)', `(click)="bMethod()"`, 1);
    const aTsSf = store.findNodes('SourceFile').find((s) => s.filePath.endsWith('a.component.ts'))!;
    const bTsSf = store.findNodes('SourceFile').find((s) => s.filePath.endsWith('b.component.ts'))!;
    seedClassMethod(aTsSf, 'AComponent.aMethod');
    seedClassMethod(bTsSf, 'BComponent.bMethod');

    const batch = resolveAngularTemplates(store, rootDir);
    // bMethod isn't on AComponent — no edge from A's template to B's method.
    expect(batch.edges).toHaveLength(0);
  });
});
