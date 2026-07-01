import { describe, expect, it } from 'vitest';
import { idFor } from '../ids.js';

describe('idFor', () => {
  describe('determinism', () => {
    it('produces the same id for the same inputs', () => {
      const a = idFor.sourceFile({ repository: 'veoable', filePath: 'src/app.ts' });
      const b = idFor.sourceFile({ repository: 'veoable', filePath: 'src/app.ts' });
      expect(a).toBe(b);
    });

    it('produces different ids for different inputs', () => {
      const a = idFor.sourceFile({ repository: 'veoable', filePath: 'src/app.ts' });
      const b = idFor.sourceFile({ repository: 'veoable', filePath: 'src/other.ts' });
      expect(a).not.toBe(b);
    });

    it('produces different ids for different repositories', () => {
      const a = idFor.sourceFile({ repository: 'repoA', filePath: 'src/app.ts' });
      const b = idFor.sourceFile({ repository: 'repoB', filePath: 'src/app.ts' });
      expect(a).not.toBe(b);
    });
  });

  describe('format', () => {
    it('uses {type}:{16-hex} format', () => {
      const id = idFor.sourceFile({ repository: 'r', filePath: 'f' });
      expect(id).toMatch(/^SourceFile:[0-9a-f]{16}$/);
    });

    it('prefixes each node type distinctly', () => {
      expect(idFor.functionDefinition({ sourceFileId: 'x', name: 'f', sourceLine: 1 })).toMatch(/^FunctionDefinition:/);
      expect(idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/x', filePath: 'a.ts', lineStart: 1 })).toMatch(/^APIEndpoint:/);
      expect(idFor.databaseSystem({ kind: 'postgres', name: 'main' })).toMatch(/^DatabaseSystem:/);
      expect(idFor.databaseTable({ systemId: 's', schema: null, name: 'users' })).toMatch(/^DatabaseTable:/);
      expect(idFor.databaseColumn({ tableId: 't', name: 'id' })).toMatch(/^DatabaseColumn:/);
      expect(
        idFor.databaseInteraction({ callSiteFunctionId: 'f', operation: 'read', targetTableId: 't' })
      ).toMatch(/^DatabaseInteraction:/);
      expect(idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 1, urlLiteral: '/x' })).toMatch(
        /^ClientSideAPICaller:/
      );
      expect(idFor.clientSideProcess({ sourceFileId: 'f', sourceLine: 1, name: 'onClick' })).toMatch(
        /^ClientSideProcess:/
      );
    });
  });

  describe('idempotency for cross-cutting node types', () => {
    it('database tables collide on (system, schema, name)', () => {
      const a = idFor.databaseTable({ systemId: 'sys1', schema: 'public', name: 'users' });
      const b = idFor.databaseTable({ systemId: 'sys1', schema: 'public', name: 'users' });
      expect(a).toBe(b);
    });

    it('api endpoints collide on (repo, method, route, file, line) regardless of method case', () => {
      const a = idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/users/:id', filePath: 'a.ts', lineStart: 5 });
      const b = idFor.apiEndpoint({ repository: 'r', httpMethod: 'get', routePattern: '/users/:id', filePath: 'a.ts', lineStart: 5 });
      expect(a).toBe(b);
    });

    it('api endpoints with same (repo, method, route) but different files produce DIFFERENT ids (#185)', () => {
      // The whole point of #185 — pre-fix these collided and the
      // canonical store last-write-wins dropped one of them.
      const a = idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/:id', filePath: 'routes/diagrams.ts', lineStart: 14 });
      const b = idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/:id', filePath: 'routes/projects.ts', lineStart: 214 });
      expect(a).not.toBe(b);
    });

    it('api endpoints with same (repo, method, route, file) but different lines produce DIFFERENT ids', () => {
      // Two route declarations behind a feature flag in the same
      // file. Both should survive as distinct endpoints.
      const a = idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/users', filePath: 'a.ts', lineStart: 10 });
      const b = idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/users', filePath: 'a.ts', lineStart: 25 });
      expect(a).not.toBe(b);
    });
  });

  describe('different inputs produce different ids for every node type', () => {
    it('sourceFile: differs on repository and filePath', () => {
      const base = idFor.sourceFile({ repository: 'r', filePath: 'a.ts' });
      expect(base).not.toBe(idFor.sourceFile({ repository: 'r2', filePath: 'a.ts' }));
      expect(base).not.toBe(idFor.sourceFile({ repository: 'r', filePath: 'b.ts' }));
    });

    it('functionDefinition: differs on sourceFileId, name, and sourceLine', () => {
      const base = idFor.functionDefinition({ sourceFileId: 'f', name: 'g', sourceLine: 1 });
      expect(base).not.toBe(idFor.functionDefinition({ sourceFileId: 'f2', name: 'g', sourceLine: 1 }));
      expect(base).not.toBe(idFor.functionDefinition({ sourceFileId: 'f', name: 'h', sourceLine: 1 }));
      expect(base).not.toBe(idFor.functionDefinition({ sourceFileId: 'f', name: 'g', sourceLine: 2 }));
    });

    it('apiEndpoint: differs on repo, method, and routePattern', () => {
      const base = idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/x', filePath: 'a.ts', lineStart: 1 });
      expect(base).not.toBe(idFor.apiEndpoint({ repository: 'r2', httpMethod: 'GET', routePattern: '/x', filePath: 'a.ts', lineStart: 1 }));
      expect(base).not.toBe(idFor.apiEndpoint({ repository: 'r', httpMethod: 'POST', routePattern: '/x', filePath: 'a.ts', lineStart: 1 }));
      expect(base).not.toBe(idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/y', filePath: 'a.ts', lineStart: 1 }));
    });

    it('clientSideAPICaller: differs on sourceFileId, sourceLine, urlLiteral', () => {
      const base = idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 1, urlLiteral: '/x' });
      expect(base).not.toBe(idFor.clientSideAPICaller({ sourceFileId: 'f2', sourceLine: 1, urlLiteral: '/x' }));
      expect(base).not.toBe(idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 2, urlLiteral: '/x' }));
      expect(base).not.toBe(idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 1, urlLiteral: '/y' }));
    });

    it('clientSideProcess: differs on sourceFileId, sourceLine, name', () => {
      const base = idFor.clientSideProcess({ sourceFileId: 'f', sourceLine: 1, name: 'onClick' });
      expect(base).not.toBe(idFor.clientSideProcess({ sourceFileId: 'f2', sourceLine: 1, name: 'onClick' }));
      expect(base).not.toBe(idFor.clientSideProcess({ sourceFileId: 'f', sourceLine: 2, name: 'onClick' }));
      expect(base).not.toBe(idFor.clientSideProcess({ sourceFileId: 'f', sourceLine: 1, name: 'onSubmit' }));
    });

    it('databaseSystem: differs on kind and name', () => {
      const base = idFor.databaseSystem({ kind: 'postgres', name: 'main' });
      expect(base).not.toBe(idFor.databaseSystem({ kind: 'mysql', name: 'main' }));
      expect(base).not.toBe(idFor.databaseSystem({ kind: 'postgres', name: 'other' }));
    });

    it('databaseTable: differs on systemId, schema, name', () => {
      const base = idFor.databaseTable({ systemId: 's', schema: 'public', name: 'users' });
      expect(base).not.toBe(idFor.databaseTable({ systemId: 's2', schema: 'public', name: 'users' }));
      expect(base).not.toBe(idFor.databaseTable({ systemId: 's', schema: 'other', name: 'users' }));
      expect(base).not.toBe(idFor.databaseTable({ systemId: 's', schema: 'public', name: 'orders' }));
      // null schema distinct from 'public'
      expect(base).not.toBe(idFor.databaseTable({ systemId: 's', schema: null, name: 'users' }));
    });

    it('databaseColumn: differs on tableId and name', () => {
      const base = idFor.databaseColumn({ tableId: 't', name: 'id' });
      expect(base).not.toBe(idFor.databaseColumn({ tableId: 't2', name: 'id' }));
      expect(base).not.toBe(idFor.databaseColumn({ tableId: 't', name: 'email' }));
    });

    it('databaseInteraction: differs on callSite, operation, targetTable', () => {
      const base = idFor.databaseInteraction({
        callSiteFunctionId: 'f',
        operation: 'read',
        targetTableId: 't',
      });
      expect(base).not.toBe(
        idFor.databaseInteraction({ callSiteFunctionId: 'f2', operation: 'read', targetTableId: 't' })
      );
      expect(base).not.toBe(
        idFor.databaseInteraction({ callSiteFunctionId: 'f', operation: 'write', targetTableId: 't' })
      );
      expect(base).not.toBe(
        idFor.databaseInteraction({ callSiteFunctionId: 'f', operation: 'read', targetTableId: 't2' })
      );
    });
  });

  describe('idempotency for remaining node types', () => {
    it('function definitions collide on (sourceFile, name, sourceLine)', () => {
      const a = idFor.functionDefinition({ sourceFileId: 'f', name: 'g', sourceLine: 10 });
      const b = idFor.functionDefinition({ sourceFileId: 'f', name: 'g', sourceLine: 10 });
      expect(a).toBe(b);
    });

    it('database systems collide on (kind, name)', () => {
      expect(idFor.databaseSystem({ kind: 'postgres', name: 'main' })).toBe(
        idFor.databaseSystem({ kind: 'postgres', name: 'main' })
      );
    });
  });

  // Gap 6: parameterized format check across every helper
  describe('format regex for every helper', () => {
    const cases: Array<{ name: string; prefix: string; id: string }> = [
      {
        name: 'sourceFile',
        prefix: 'SourceFile',
        id: idFor.sourceFile({ repository: 'r', filePath: 'f' }),
      },
      {
        name: 'functionDefinition',
        prefix: 'FunctionDefinition',
        id: idFor.functionDefinition({ sourceFileId: 'f', name: 'g', sourceLine: 1 }),
      },
      {
        name: 'apiEndpoint',
        prefix: 'APIEndpoint',
        id: idFor.apiEndpoint({ repository: 'r', httpMethod: 'GET', routePattern: '/x', filePath: 'a.ts', lineStart: 1 }),
      },
      {
        name: 'clientSideAPICaller',
        prefix: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 1, urlLiteral: '/x' }),
      },
      {
        name: 'clientSideProcess',
        prefix: 'ClientSideProcess',
        id: idFor.clientSideProcess({ sourceFileId: 'f', sourceLine: 1, name: 'onClick' }),
      },
      {
        name: 'databaseSystem',
        prefix: 'DatabaseSystem',
        id: idFor.databaseSystem({ kind: 'postgres', name: 'main' }),
      },
      {
        name: 'databaseTable',
        prefix: 'DatabaseTable',
        id: idFor.databaseTable({ systemId: 's', schema: 'public', name: 'users' }),
      },
      {
        name: 'databaseColumn',
        prefix: 'DatabaseColumn',
        id: idFor.databaseColumn({ tableId: 't', name: 'id' }),
      },
      {
        name: 'databaseInteraction',
        prefix: 'DatabaseInteraction',
        id: idFor.databaseInteraction({ callSiteFunctionId: 'f', operation: 'read', targetTableId: 't' }),
      },
    ];

    it.each(cases)('$name produces $prefix:[16 hex] format', ({ prefix, id }) => {
      expect(id).toMatch(new RegExp(`^${prefix}:[0-9a-f]{16}$`));
    });
  });

  // Gap 7: edge-value robustness
  describe('field-boundary collision resistance', () => {
    it('sourceFile: shifting characters across (repository, filePath) yields different ids', () => {
      const a = idFor.sourceFile({ repository: 'a', filePath: 'bc' });
      const b = idFor.sourceFile({ repository: 'ab', filePath: 'c' });
      expect(a).not.toBe(b);
    });

    it('databaseTable: shifting characters across (schema, name) yields different ids', () => {
      const a = idFor.databaseTable({ systemId: 's', schema: 'a', name: 'bc' });
      const b = idFor.databaseTable({ systemId: 's', schema: 'ab', name: 'c' });
      expect(a).not.toBe(b);
    });

    it('sourceFile: empty-string fields produce a valid id (no throw, no empty hash)', () => {
      const id = idFor.sourceFile({ repository: '', filePath: '' });
      expect(id).toMatch(/^SourceFile:[0-9a-f]{16}$/);
    });
  });

  describe('Screen id with optional routePath (#187 schema bits)', () => {
    it('RN screens (no routePath) produce stable ids that don\'t collide with web screens', () => {
      const rn = idFor.screen({ repository: 'r', name: 'UserDetail' });
      const rnExplicitNull = idFor.screen({ repository: 'r', name: 'UserDetail', routePath: null });
      // Omitted vs explicit null are equivalent.
      expect(rn).toBe(rnExplicitNull);
    });

    it('two web screens sharing a component name but different paths get distinct ids', () => {
      const a = idFor.screen({ repository: 'r', name: 'Page', routePath: '/users/:id' });
      const b = idFor.screen({ repository: 'r', name: 'Page', routePath: '/users/:id/edit' });
      expect(a).not.toBe(b);
    });

    it('an RN screen and a web screen with the same name don\'t collide', () => {
      const rn = idFor.screen({ repository: 'r', name: 'Profile' });
      const web = idFor.screen({ repository: 'r', name: 'Profile', routePath: '/profile' });
      expect(rn).not.toBe(web);
    });
  });

  describe('null vs missing url for client-side callers', () => {
    it('null url and "dynamic" string url collide (both treated as dynamic)', () => {
      const a = idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 10, urlLiteral: null });
      const b = idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 10, urlLiteral: 'dynamic' });
      expect(a).toBe(b);
    });

    it('different concrete urls do not collide', () => {
      const a = idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 10, urlLiteral: '/users' });
      const b = idFor.clientSideAPICaller({ sourceFileId: 'f', sourceLine: 10, urlLiteral: '/orders' });
      expect(a).not.toBe(b);
    });
  });
});
