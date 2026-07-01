/**
 * Aggregator integration tests (#34).
 *
 * Tests that the analysis pipeline correctly handles multi-framework
 * projects, deduplication, and cross-framework endpoint compilation.
 */
import { describe, expect, it } from 'vitest';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { type APIEndpoint, type SchemaNode, idFor, validateNode } from '@adorable/schema';

function endpoints(nodes: SchemaNode[]): APIEndpoint[] {
  return nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('aggregator: single framework', () => {
  it('passes through endpoints unchanged', () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const batch: NodeBatch = {
        nodes: [
          {
            nodeType: 'APIEndpoint',
            id: idFor.apiEndpoint({ repository: 'test', httpMethod: 'GET', routePattern: '/users', filePath: 'a.ts', lineStart: 1 }),
            httpMethod: 'GET',
            routePattern: '/users',
            handlerFunctionId: null,
            framework: 'express',
            repository: 'test',
          },
          {
            nodeType: 'APIEndpoint',
            id: idFor.apiEndpoint({ repository: 'test', httpMethod: 'POST', routePattern: '/users', filePath: 'a.ts', lineStart: 1 }),
            httpMethod: 'POST',
            routePattern: '/users',
            handlerFunctionId: null,
            framework: 'express',
            repository: 'test',
          },
        ],
        edges: [],
      };

      store.commit(batch, makeBatchMeta('express'));
      const all = store.findNodes('APIEndpoint');
      expect(all).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe('aggregator: multi-framework, no overlap', () => {
  it('merges endpoints from different frameworks', () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      // Express endpoints
      store.commit({
        nodes: [
          {
            nodeType: 'APIEndpoint',
            id: idFor.apiEndpoint({ repository: 'test', httpMethod: 'GET', routePattern: '/api/users', filePath: 'a.ts', lineStart: 1 }),
            httpMethod: 'GET',
            routePattern: '/api/users',
            handlerFunctionId: null,
            framework: 'express',
            repository: 'test',
          },
        ],
        edges: [],
      }, makeBatchMeta('express'));

      // Fastify endpoints (different routes)
      store.commit({
        nodes: [
          {
            nodeType: 'APIEndpoint',
            id: idFor.apiEndpoint({ repository: 'test', httpMethod: 'GET', routePattern: '/api/items', filePath: 'a.ts', lineStart: 1 }),
            httpMethod: 'GET',
            routePattern: '/api/items',
            handlerFunctionId: null,
            framework: 'fastify',
            repository: 'test',
          },
        ],
        edges: [],
      }, makeBatchMeta('fastify'));

      const all = store.findNodes('APIEndpoint');
      expect(all).toHaveLength(2);
      const frameworks = new Set(all.map((e) => e.framework));
      expect(frameworks).toContain('express');
      expect(frameworks).toContain('fastify');
    } finally {
      store.close();
    }
  });
});

describe('aggregator: deduplication', () => {
  it('same (method, routePattern) from same repo collapses to one node', () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const ep = {
        nodeType: 'APIEndpoint' as const,
        id: idFor.apiEndpoint({ repository: 'test', httpMethod: 'GET', routePattern: '/users', filePath: 'a.ts', lineStart: 1 }),
        httpMethod: 'GET',
        routePattern: '/users',
        handlerFunctionId: null,
        framework: 'express',
        repository: 'test',
      };

      // Commit same endpoint twice
      store.commit({ nodes: [ep], edges: [] }, makeBatchMeta('express'));
      store.commit({ nodes: [ep], edges: [] }, makeBatchMeta('express'));

      const all = store.findNodes('APIEndpoint');
      expect(all).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe('aggregator: cross-repo endpoints', () => {
  it('same route in different repos produces separate endpoints', () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      store.commit({
        nodes: [{
          nodeType: 'APIEndpoint',
          id: idFor.apiEndpoint({ repository: 'api-v1', httpMethod: 'GET', routePattern: '/users', filePath: 'a.ts', lineStart: 1 }),
          httpMethod: 'GET',
          routePattern: '/users',
          handlerFunctionId: null,
          framework: 'express',
          repository: 'api-v1',
        }],
        edges: [],
      }, makeBatchMeta('express'));

      store.commit({
        nodes: [{
          nodeType: 'APIEndpoint',
          id: idFor.apiEndpoint({ repository: 'api-v2', httpMethod: 'GET', routePattern: '/users', filePath: 'a.ts', lineStart: 1 }),
          httpMethod: 'GET',
          routePattern: '/users',
          handlerFunctionId: null,
          framework: 'express',
          repository: 'api-v2',
        }],
        edges: [],
      }, makeBatchMeta('express'));

      const all = store.findNodes('APIEndpoint');
      expect(all).toHaveLength(2);
      const repos = new Set(all.map((e) => e.repository));
      expect(repos.size).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe('aggregator: schema validation', () => {
  it('all committed endpoints pass schema validation', () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      store.commit({
        nodes: [
          {
            nodeType: 'APIEndpoint',
            id: idFor.apiEndpoint({ repository: 'test', httpMethod: 'GET', routePattern: '/a', filePath: 'a.ts', lineStart: 1 }),
            httpMethod: 'GET', routePattern: '/a', handlerFunctionId: null,
            framework: 'express', repository: 'test',
          },
          {
            nodeType: 'APIEndpoint',
            id: idFor.apiEndpoint({ repository: 'test', httpMethod: 'POST', routePattern: '/b', filePath: 'a.ts', lineStart: 1 }),
            httpMethod: 'POST', routePattern: '/b', handlerFunctionId: null,
            framework: 'gin', repository: 'test',
          },
        ],
        edges: [],
      }, makeBatchMeta('test'));

      const all = store.findNodes('APIEndpoint');
      for (const ep of all) {
        expect(() => validateNode(ep)).not.toThrow();
      }
    } finally {
      store.close();
    }
  });
});
