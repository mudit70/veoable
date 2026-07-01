import { describe, expect, it } from 'vitest';
import {
  buildApplicationScope,
  ALLOW_ANY_APPLICATION_PAIR,
} from '../application-scope.js';

describe('buildApplicationScope', () => {
  it('returns ALLOW-ALL semantics when no applications declared', () => {
    const scope = buildApplicationScope([]);
    expect(scope('any-repo', 'other-repo')).toBe(true);
  });

  it('allows matches within the same application', () => {
    const scope = buildApplicationScope([
      { name: 'rn', repos: ['rn-client', 'rn-backend'] },
      { name: 'admin', repos: ['admin-web', 'admin-backend'] },
    ]);
    expect(scope('rn-client', 'rn-backend')).toBe(true);
    expect(scope('admin-web', 'admin-backend')).toBe(true);
  });

  it('blocks cross-application matches', () => {
    const scope = buildApplicationScope([
      { name: 'rn', repos: ['rn-client', 'rn-backend'] },
      { name: 'admin', repos: ['admin-web', 'admin-backend'] },
    ]);
    expect(scope('rn-client', 'admin-backend')).toBe(false);
    expect(scope('admin-web', 'rn-backend')).toBe(false);
  });

  it('treats unscoped callers as permissive (incremental adoption)', () => {
    const scope = buildApplicationScope([
      { name: 'rn', repos: ['rn-client', 'rn-backend'] },
    ]);
    // 'mystery-repo' is not in any app — it can stitch to anything.
    expect(scope('mystery-repo', 'rn-backend')).toBe(true);
    expect(scope('mystery-repo', 'admin-backend')).toBe(true);
  });

  it('allows scoped callers to reach unscoped endpoints (shared-service pattern)', () => {
    const scope = buildApplicationScope([
      { name: 'rn', repos: ['rn-client', 'rn-backend'] },
    ]);
    // 'random-backend' is unscoped — incremental adoption should not
    // silently break flows to undeclared repos. Only cross-app
    // contamination (where BOTH ends are declared in different apps)
    // is blocked.
    expect(scope('rn-client', 'random-backend')).toBe(true);
  });

  it('a repo can belong to multiple applications (shared service)', () => {
    const scope = buildApplicationScope([
      { name: 'rn', repos: ['rn-client', 'shared-utils'] },
      { name: 'admin', repos: ['admin-web', 'shared-utils'] },
    ]);
    expect(scope('rn-client', 'shared-utils')).toBe(true);
    expect(scope('admin-web', 'shared-utils')).toBe(true);
    // But rn-client cannot reach admin-web.
    expect(scope('rn-client', 'admin-web')).toBe(false);
  });

  it('treats same-repo (caller and endpoint in one repo) as allowed when scoped', () => {
    const scope = buildApplicationScope([
      { name: 'rn', repos: ['rn-monolith'] },
    ]);
    expect(scope('rn-monolith', 'rn-monolith')).toBe(true);
  });

  it('ALLOW_ANY_APPLICATION_PAIR sentinel lets every pair through', () => {
    expect(ALLOW_ANY_APPLICATION_PAIR('a', 'b')).toBe(true);
  });
});
