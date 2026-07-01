import { describe, expect, it } from 'vitest';
import { Project, SyntaxKind } from 'ts-morph';
import { resolveCallerUrl, reconstructFromParts } from '../resolve-constant.js';

/**
 * Unit tests for the unified caller-URL resolver introduced in #188.
 * Both `framework-fetch` and `framework-axios` route through this
 * helper, so flipping these tests would surface in both visitors.
 */

function resolveCall(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('test.ts', source);
  const decl = file
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((d) => d.getName() === '_x');
  if (!decl) throw new Error('test setup error: _x not declared');
  const init = decl.getInitializer();
  if (!init) throw new Error('test setup error: _x has no initializer');
  return resolveCallerUrl(init);
}

describe('resolveCallerUrl (#188)', () => {
  it('string literal → exact, urlLiteral is the value, no template metadata', () => {
    const r = resolveCall(`const _x = '/api/users';`);
    expect(r.urlLiteral).toBe('/api/users');
    expect(r.egressConfidence).toBe('exact');
    expect(r.templateParts).toBeNull();
    expect(r.templateSpanCount).toBeNull();
    expect(r.templateSegmentCount).toBeNull();
  });

  it('no-substitution template literal → exact', () => {
    const r = resolveCall('const _x = `/api/users`;');
    expect(r.urlLiteral).toBe('/api/users');
    expect(r.egressConfidence).toBe('exact');
  });

  it('template with one placeholder → :p0 reconstruction with pattern confidence', () => {
    const r = resolveCall(`
      function fn(id: number) {
        const _x = \`/api/users/\${id}\`;
        return _x;
      }
    `);
    expect(r.urlLiteral).toBe('/api/users/:p0');
    expect(r.egressConfidence).toBe('pattern');
    expect(r.templateParts).toEqual(['/api/users/', '']);
    expect(r.templateSpanCount).toBe(1);
    expect(r.templateSegmentCount).toBe(3); // api + users + :p0
  });

  it('template with placeholder in the middle keeps both halves', () => {
    const r = resolveCall(`
      function fn(id: number) {
        const _x = \`/api/users/\${id}/posts\`;
        return _x;
      }
    `);
    expect(r.urlLiteral).toBe('/api/users/:p0/posts');
    expect(r.egressConfidence).toBe('pattern');
    expect(r.templateSegmentCount).toBe(4); // api + users + :p0 + posts
  });

  it('template with empty head and one placeholder still surfaces a leading :p0', () => {
    const r = resolveCall(`
      function fn(base: string) {
        const _x = \`\${base}/api/users\`;
        return _x;
      }
    `);
    // Pre-#188 the bespoke fetch path stored urlLiteral=null because
    // the head was empty. resolveUrlPattern + reconstructFromParts now
    // reflect the leading placeholder.
    expect(r.urlLiteral).toBe(':p0/api/users');
    expect(r.egressConfidence).toBe('pattern');
  });

  it('binary `+` concat with one resolved side → pattern with :p0', () => {
    const r = resolveCall(`
      function fn(name: string) {
        const _x = '/api/' + name;
        return _x;
      }
    `);
    expect(r.urlLiteral).toBe('/api/:p0');
    expect(r.egressConfidence).toBe('pattern');
  });

  it('binary `+` concat with both sides resolved → exact', () => {
    const r = resolveCall(`
      const _x = '/api/' + 'health';
    `);
    expect(r.urlLiteral).toBe('/api/health');
    expect(r.egressConfidence).toBe('exact');
  });

  it('template with a constant interpolation collapses fully → exact', () => {
    const r = resolveCall(`
      const HOST = 'https://api.example.com';
      const _x = \`\${HOST}/v1/health\`;
    `);
    expect(r.urlLiteral).toBe('https://api.example.com/v1/health');
    expect(r.egressConfidence).toBe('exact');
  });

  it('template with a resolved-constant prefix and a dynamic middle → pattern', () => {
    const r = resolveCall(`
      const HOST = 'https://api.example.com';
      function fn(id: number) {
        const _x = \`\${HOST}/api/users/\${id}\`;
        return _x;
      }
    `);
    expect(r.urlLiteral).toBe('https://api.example.com/api/users/:p0');
    expect(r.egressConfidence).toBe('pattern');
  });

  it('property access to an object literal value resolves → exact', () => {
    const r = resolveCall(`
      const ApiConstant = { LOGIN: 'auth/login' };
      const _x = ApiConstant.LOGIN;
    `);
    expect(r.urlLiteral).toBe('auth/login');
    expect(r.egressConfidence).toBe('exact');
  });

  it('fully-dynamic identifier → all fields null with dynamic confidence', () => {
    const r = resolveCall(`
      function fn(url: string) {
        const _x = url;
        return _x;
      }
    `);
    expect(r.urlLiteral).toBeNull();
    expect(r.egressConfidence).toBe('dynamic');
    expect(r.templateParts).toBeNull();
    expect(r.templateSpanCount).toBeNull();
    expect(r.templateSegmentCount).toBeNull();
  });

  it('NewExpression (e.g., new URL(...)) is not statically resolvable → dynamic', () => {
    const r = resolveCall(`
      const _x = new URL('/api/users', 'https://example.com');
    `);
    expect(r.urlLiteral).toBeNull();
    expect(r.egressConfidence).toBe('dynamic');
  });

  it('query string is preserved on the caller side (dispatcher patterns like ?r= live in the query)', () => {
    const r = resolveCall(`
      function fn(id: number) {
        const _x = \`/api/users/\${id}?expand=profile\`;
        return _x;
      }
    `);
    // Visitor-emit paths preserve query strings (stripQuery: false in
    // resolveCallerUrl). The stitcher's matcher already handles caller
    // URLs with queries via the wrapper-resolver path; keeping bare-fetch
    // symmetric avoids losing dispatcher shapes like `${url}?r=${name}`.
    expect(r.urlLiteral).toBe('/api/users/:p0?expand=profile');
    expect(r.egressConfidence).toBe('pattern');
  });

  it('dispatcher pattern `${url}?r=${name}` survives with both placeholders intact', () => {
    const r = resolveCall(`
      class API {
        url = '';
        run(name: string) {
          const _x = \`\${this.url}?r=\${name}\`;
          return _x;
        }
      }
    `);
    // Pre-#188-fix this collapsed to dynamic because resolveUrlPattern
    // stripped the query. With stripQuery: false the dispatcher shape
    // round-trips into the stitcher.
    expect(r.urlLiteral).toBe(':p0?r=:p1');
    expect(r.templateParts).toEqual(['', '?r=', '']);
    expect(r.egressConfidence).toBe('pattern');
  });
});

describe('reconstructFromParts (#188)', () => {
  it('mirrors the stitcher reconstruction at url-matcher.ts:138-141', () => {
    expect(reconstructFromParts(['/projects/', '/diagrams'])).toBe('/projects/:p0/diagrams');
    expect(reconstructFromParts(['', '/api/users'])).toBe(':p0/api/users');
    expect(reconstructFromParts(['/api/users'])).toBe('/api/users');
    expect(reconstructFromParts(['/a/', '/b/', '/c'])).toBe('/a/:p0/b/:p1/c');
  });
});
