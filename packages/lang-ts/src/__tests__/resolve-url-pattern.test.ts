import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { resolveUrlPattern, type UrlPattern } from '../resolve-constant.js';

/**
 * Build a ts-morph Project with the given source as `test.ts` and return
 * the AST node at offset matching the marker `URL:` followed by the
 * expression on the next line. Tests pass a fragment of the form:
 *
 *   const _x =
 *     <expression-under-test>;
 *
 * and we extract the initializer of `_x` to feed `resolveUrlPattern`.
 *
 * Includes a `const ApiConstant = { … }` map so test expressions can
 * reference common constants without re-declaring them in each test.
 */
function resolve(expr: string): UrlPattern | null {
  const source = `
    const ApiConstant = {
      LOGIN: 'auth/login',
      SONGS: 'songs',
      SONG_DETAIL: 'songs/',
      PLAYLIST_DETAILS: 'playlists/',
      DEL_PLAYLIST: 'playlists/',
      SEARCH: 'search?search=',
      LOGGED_IN_USER: 'users/profile/loggedInUser',
    };
    const _x = ${expr};
  `;
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('test.ts', source);
  const decl = file.getVariableDeclaration('_x');
  if (!decl) throw new Error('test setup error: _x not declared');
  const init = decl.getInitializer();
  if (!init) throw new Error('test setup error: _x has no initializer');
  return resolveUrlPattern(init);
}

describe('resolveUrlPattern — simple cases', () => {
  it('resolves a string literal as fully-resolved with one part', () => {
    const r = resolve(`'auth/login'`)!;
    expect(r.pattern).toBe('auth/login');
    expect(r.fullyResolved).toBe(true);
    expect(r.templateSpanCount).toBe(0);
    expect(r.templateParts).toEqual(['auth/login']);
  });

  it('resolves a no-substitution template literal', () => {
    const r = resolve('`auth/login`')!;
    expect(r.pattern).toBe('auth/login');
    expect(r.fullyResolved).toBe(true);
  });

  it('resolves an imported / object-property constant', () => {
    const r = resolve('ApiConstant.LOGIN')!;
    expect(r.pattern).toBe('auth/login');
    expect(r.fullyResolved).toBe(true);
  });
});

describe('resolveUrlPattern — template expression with constant prefix (#179)', () => {
  it('inlines a resolved constant span and keeps the unresolved span as a placeholder', () => {
    const r = resolve('`${ApiConstant.SONGS}/${id}/like`')!;
    expect(r.pattern).toBe('songs/${id}/like');
    expect(r.fullyResolved).toBe(false);
    expect(r.templateSpanCount).toBe(1);
    expect(r.templateParts).toEqual(['songs/', '/like']);
  });

  it('handles head-only template literals (resolved span at start, no prefix text)', () => {
    const r = resolve('`${ApiConstant.LOGIN}`')!;
    // Single fully-resolved span → equivalent to the literal value.
    expect(r.pattern).toBe('auth/login');
    expect(r.fullyResolved).toBe(true);
  });

  it('keeps multiple unresolved spans as separate placeholders', () => {
    const r = resolve('`${ApiConstant.SONGS}/${userId}/comments/${commentId}`')!;
    expect(r.pattern).toBe('songs/${userId}/comments/${commentId}');
    expect(r.templateSpanCount).toBe(2);
    expect(r.templateParts).toEqual(['songs/', '/comments/', '']);
  });
});

describe('resolveUrlPattern — `+` concatenation (musiccardapp pattern)', () => {
  it('resolves ApiConstant.SONG_DETAIL + id + "/claps?claped=" + payload', () => {
    const r = resolve(`ApiConstant.SONG_DETAIL + id + '/claps?claped=' + payload`)!;
    // SONG_DETAIL = 'songs/'. After query-string strip:
    //   pattern: 'songs/${id}/claps'
    //   parts:   ['songs/', '/claps']
    expect(r.pattern).toBe('songs/${id}/claps');
    expect(r.templateSpanCount).toBe(1);
    expect(r.templateParts).toEqual(['songs/', '/claps']);
    expect(r.fullyResolved).toBe(false);
  });

  it('handles empty-string padding between operands (the musiccardapp idiom)', () => {
    // ApiConstant.PLAYLIST_DETAILS + `` + playListId + `` + ApiConstant.CGE
    const r = resolve(`ApiConstant.PLAYLIST_DETAILS + '' + playListId + '' + 'addSong'`)!;
    expect(r.pattern).toBe('playlists/${playListId}addSong');
    expect(r.fullyResolved).toBe(false);
  });

  it('flattens left-associative chains of `+`', () => {
    const r = resolve(`'a/' + b + '/c/' + d + '/e'`)!;
    expect(r.pattern).toBe('a/${b}/c/${d}/e');
    expect(r.templateSpanCount).toBe(2);
    expect(r.templateParts).toEqual(['a/', '/c/', '/e']);
  });
});

describe('resolveUrlPattern — query-string handling', () => {
  it('strips everything from the first `?` onward (path-only matching)', () => {
    const r = resolve(`'songs/' + id + '/claps?claped=' + payload`)!;
    expect(r.pattern).not.toContain('?');
    expect(r.templateParts.every((p) => !p.includes('?'))).toBe(true);
  });

  it('preserves `?` when it appears inside a placeholder name (rare)', () => {
    // The placeholder text includes the source — but since the expression
    // doesn't have a literal `?` outside the static text, nothing is stripped.
    const r = resolve('`prefix/${id}`')!;
    expect(r.pattern).toBe('prefix/${id}');
  });

  it('drops every chunk after the first `?` even when it appears past several placeholders', () => {
    // `?` appears in the third static chunk after two placeholders. The
    // post-`?` placeholder + literal must be dropped from both pattern
    // and templateParts so the stitcher doesn't try to match against
    // query-string content.
    const r = resolve(`'a/' + b + '/c/' + d + '?x=' + e + '/dropped'`)!;
    expect(r.pattern).toBe('a/${b}/c/${d}');
    expect(r.templateSpanCount).toBe(2);
    expect(r.templateParts).toEqual(['a/', '/c/', '']);
  });

  it('drops `?` that appears in the very first static chunk', () => {
    const r = resolve(`'/search?q=' + q`)!;
    // After strip: pattern '/search', no placeholders survive.
    expect(r.pattern).toBe('/search');
    expect(r.fullyResolved).toBe(true);
    expect(r.templateParts).toEqual(['/search']);
    expect(r.templateSpanCount).toBe(0);
  });
});

describe('resolveUrlPattern — fully dynamic returns null', () => {
  it('returns null when nothing resolves to a literal', () => {
    expect(resolve('foo')).toBe(null);
    expect(resolve('foo()')).toBe(null);
  });

  it('returns null for `${id}` alone (no static content survives)', () => {
    expect(resolve('`${id}`')).toBe(null);
  });

  it('returns null for `unknown.member` that does not resolve', () => {
    expect(resolve('unresolved.x')).toBe(null);
  });
});

describe('resolveUrlPattern — preserves the existing exact-resolution contract', () => {
  it('fully-resolved chains do not produce placeholders', () => {
    const r = resolve(`'a/' + 'b/' + 'c'`)!;
    expect(r.pattern).toBe('a/b/c');
    expect(r.fullyResolved).toBe(true);
    expect(r.templateSpanCount).toBe(0);
    expect(r.templateParts).toEqual(['a/b/c']);
  });

  it('a fully-resolved template expression (head + resolved span + tail) is exact', () => {
    const r = resolve('`${ApiConstant.SONGS}/upload`')!;
    expect(r.pattern).toBe('songs/upload');
    expect(r.fullyResolved).toBe(true);
  });
});
