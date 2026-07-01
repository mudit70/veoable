import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { resolveToString } from '../resolve-constant.js';

/**
 * Tests for #193's pure-function evaluator extension to
 * `resolveToString`. A call to a function whose body is a single
 * `return <stringExpr>` (or arrow with expression body) gets inlined
 * with the call-site arguments substituted for parameters.
 */

function resolveExpr(source: string): string | null {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('test.ts', source);
  const decl = file.getVariableDeclaration('_x');
  if (!decl) throw new Error('test setup error: _x not declared');
  const init = decl.getInitializer();
  if (!init) throw new Error('test setup error: _x has no initializer');
  return resolveToString(init);
}

describe('resolveToString — pure-function evaluation (#193)', () => {
  it('evaluates a function declaration with single-return body', () => {
    const src = `
      function makePath(prefix: string) {
        return prefix + '/users/:id';
      }
      const _x = makePath('/api');
    `;
    expect(resolveExpr(src)).toBe('/api/users/:id');
  });

  it('evaluates an arrow function with expression body', () => {
    const src = `
      const makePath = (p: string) => p + '/users';
      const _x = makePath('/api');
    `;
    expect(resolveExpr(src)).toBe('/api/users');
  });

  it('evaluates an arrow function with block body and single return', () => {
    const src = `
      const makePath = (p: string) => { return p + '/users'; };
      const _x = makePath('/api');
    `;
    expect(resolveExpr(src)).toBe('/api/users');
  });

  it('evaluates a template-literal returning function', () => {
    const src = `
      function build(base: string, name: string) {
        return \`\${base}/\${name}\`;
      }
      const _x = build('api', 'users');
    `;
    expect(resolveExpr(src)).toBe('api/users');
  });

  it('substitutes through nested function calls', () => {
    const src = `
      function outer(p: string) { return inner(p) + '/list'; }
      function inner(p: string) { return p + '/users'; }
      const _x = outer('/api');
    `;
    expect(resolveExpr(src)).toBe('/api/users/list');
  });

  it('resolves the actual #193 motivating shape: route helper from a constant', () => {
    const src = `
      const platformPart = ':jadeVersion/platform/:markdownBasename';
      function getPlatformDocPageExpressRouteExpression(basePath: string) {
        return \`\${basePath}/\${platformPart}\`;
      }
      const _x = getPlatformDocPageExpressRouteExpression('/docs/jade');
    `;
    expect(resolveExpr(src)).toBe('/docs/jade/:jadeVersion/platform/:markdownBasename');
  });

  it('handles imported-style: const exported from another const-bound object', () => {
    const src = `
      const vars = { jade: { onlineDocsBaseUrl: '/docs/jade' } };
      function withDocsBase(suffix: string) {
        return vars.jade.onlineDocsBaseUrl + suffix;
      }
      const _x = withDocsBase('/sdk/:version/:name');
    `;
    expect(resolveExpr(src)).toBe('/docs/jade/sdk/:version/:name');
  });

  it('returns null for functions with multi-statement bodies', () => {
    const src = `
      function build(p: string) {
        const x = p + '/users';
        return x + '/all';
      }
      const _x = build('/api');
    `;
    expect(resolveExpr(src)).toBe(null);
  });

  it('returns null for functions with branches', () => {
    const src = `
      function build(p: string) {
        if (p === '/api') return p + '/users';
        return '/other';
      }
      const _x = build('/api');
    `;
    expect(resolveExpr(src)).toBe(null);
  });

  it('returns null when called with insufficient arguments (parameter unresolved)', () => {
    const src = `
      function build(prefix: string, suffix: string) {
        return prefix + suffix;
      }
      const _x = build('/api');
    `;
    // suffix is unresolved → bodyExpr can't be fully evaluated.
    expect(resolveExpr(src)).toBe(null);
  });

  it('returns null when the call target is not a plain function', () => {
    const src = `
      class Builder {
        make(p: string) { return p + '/users'; }
      }
      const b = new Builder();
      const _x = b.make('/api');
    `;
    expect(resolveExpr(src)).toBe(null);
  });

  it('caps recursion depth on mutually-recursive functions', () => {
    const src = `
      function a(p: string): string { return b(p); }
      function b(p: string): string { return a(p); }
      const _x = a('/api');
    `;
    expect(resolveExpr(src)).toBe(null);
  });
});

describe('resolveToString — cross-file ImportSpecifier resolution (#386)', () => {
  function resolveAcrossFiles(consumerSrc: string, producerSrc: string): string | null {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('producer.ts', producerSrc);
    const consumer = project.createSourceFile('consumer.ts', consumerSrc);
    const decl = consumer.getVariableDeclaration('_x');
    if (!decl) throw new Error('test setup error: _x not declared');
    const init = decl.getInitializer();
    if (!init) throw new Error('test setup error: _x has no initializer');
    return resolveToString(init);
  }

  it('follows a named ImportSpecifier to the producer file constant', () => {
    const consumer = `
      import { USERS_TABLE } from './producer.js';
      const _x = USERS_TABLE;
    `;
    const producer = `export const USERS_TABLE = 'users';`;
    expect(resolveAcrossFiles(consumer, producer)).toBe('users');
  });

  it('follows a renamed ImportSpecifier (import { X as Y })', () => {
    const consumer = `
      import { USERS_TABLE as T } from './producer.js';
      const _x = T;
    `;
    const producer = `export const USERS_TABLE = 'users';`;
    expect(resolveAcrossFiles(consumer, producer)).toBe('users');
  });

  it('follows a default-import ImportClause', () => {
    const consumer = `
      import TABLE from './producer.js';
      const _x = TABLE;
    `;
    const producer = `const v = 'users'; export default v;`;
    // Default re-exports through a const binding — should resolve.
    expect(resolveAcrossFiles(consumer, producer)).toBe('users');
  });

  it('returns null when the import target is not a string-valued const', () => {
    const consumer = `
      import { fn } from './producer.js';
      const _x = fn;
    `;
    const producer = `export function fn() { return 'users'; }`;
    // Function references aren't strings; should not resolve.
    expect(resolveAcrossFiles(consumer, producer)).toBe(null);
  });

  it('returns null when the producer module is missing', () => {
    // No producer file in the project — getModuleSpecifierSourceFile returns null.
    const project = new Project({ useInMemoryFileSystem: true });
    const consumer = project.createSourceFile('consumer.ts', `
      import { X } from './unknown.js';
      const _x = X;
    `);
    const decl = consumer.getVariableDeclaration('_x')!;
    expect(resolveToString(decl.getInitializer()!)).toBe(null);
  });

  it('terminates cleanly on a cyclic import chain (A→B→A)', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('a.ts', `import { B } from './b.js'; export const A = B;`);
    project.createSourceFile('b.ts', `import { A } from './a.js'; export const B = A;`);
    const consumer = project.createSourceFile('consumer.ts', `
      import { A } from './a.js';
      const _x = A;
    `);
    const decl = consumer.getVariableDeclaration('_x')!;
    // Should bail (depth cap or no fixed-point) rather than loop.
    expect(resolveToString(decl.getInitializer()!)).toBe(null);
  });
});

describe('resolveToString — chained property access (#407)', () => {
  it('resolves 2-level chain on a same-file const object', () => {
    const src = `
      const config = { jade: { url: '/api/jade' } };
      const _x = config.jade.url;
    `;
    expect(resolveExpr(src)).toBe('/api/jade');
  });

  it('resolves 3-level chain on a same-file const object', () => {
    const src = `
      const vars = { jade: { download: { jade: '/api/jade/jade' } } };
      const _x = vars.jade.download.jade;
    `;
    expect(resolveExpr(src)).toBe('/api/jade/jade');
  });

  it('resolves chained access on a default-imported const object', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('vars.ts', `
      const vars = {
        jade: {
          jadeDownloadUrl: '/api/jade/jade',
          bundleDownloadUrl: '/api/jade/jadb',
        },
      };
      export default vars;
    `);
    const consumer = project.createSourceFile('consumer.ts', `
      import vars from './vars';
      const _x = vars.jade.jadeDownloadUrl;
    `);
    const init = consumer.getVariableDeclaration('_x')!.getInitializer()!;
    expect(resolveToString(init)).toBe('/api/jade/jade');
  });

  it('resolves chained access on a named-imported const object', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('vars.ts', `
      export const config = {
        api: { base: '/api/v1' },
      };
    `);
    const consumer = project.createSourceFile('consumer.ts', `
      import { config } from './vars';
      const _x = config.api.base;
    `);
    const init = consumer.getVariableDeclaration('_x')!.getInitializer()!;
    expect(resolveToString(init)).toBe('/api/v1');
  });

  it('returns null when an intermediate property is missing', () => {
    const src = `
      const vars = { jade: { url: '/api/jade' } };
      const _x = vars.jade.missing;
    `;
    expect(resolveExpr(src)).toBe(null);
  });

  it('returns null when the chain root is a function parameter', () => {
    // The Sixclear vars: any pattern — chain can't fold across a
    // parameter. Documented limitation.
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile('test.ts', `
      function setupRoutes(vars: { jade: { url: string } }) {
        return vars.jade.url;
      }
    `);
    const fn = file.getFunctionOrThrow('setupRoutes');
    const ret = fn.getBody()!.getStatements()[0];
    // The returned expression is `vars.jade.url`.
    const expr = (ret as import('ts-morph').ReturnStatement).getExpression()!;
    expect(resolveToString(expr)).toBe(null);
  });
});
