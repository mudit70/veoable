import { describe, expect, it } from 'vitest';
import { idFor } from '../ids.js';
import { SchemaValidationError, validateBatch, validateEdge, validateNode } from '../validate.js';
import { SCHEMA_VERSION } from '../version.js';
import type { SchemaEdge, SchemaNode } from '../index.js';

describe('SCHEMA_VERSION', () => {
  it('is exported as a non-empty semver string', () => {
    expect(typeof SCHEMA_VERSION).toBe('string');
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

const repo = 'veoable';
const fileId = idFor.sourceFile({ repository: repo, filePath: 'src/users.ts' });
const fnId = idFor.functionDefinition({ sourceFileId: fileId, name: 'getUser', sourceLine: 10 });
const sysId = idFor.databaseSystem({ kind: 'postgres', name: 'main' });
const tableId = idFor.databaseTable({ systemId: sysId, schema: 'public', name: 'users' });
const interactionId = idFor.databaseInteraction({
  callSiteFunctionId: fnId,
  operation: 'read',
  targetTableId: tableId,
});

const sourceFile: SchemaNode = {
  nodeType: 'SourceFile',
  id: fileId,
  filePath: 'src/users.ts',
  repository: repo,
  language: 'ts',
  framework: null,
};

const fn: SchemaNode = {
  nodeType: 'FunctionDefinition',
  id: fnId,
  name: 'getUser',
  sourceFileId: fileId,
  sourceLine: 10,
  parameters: [{ name: 'id', type: 'string' }],
  returnType: 'Promise<User>',
  isExported: true,
  isAsync: true,
};

describe('validateNode', () => {
  it('accepts a well-formed SourceFile', () => {
    expect(validateNode(sourceFile)).toEqual(sourceFile);
  });

  it('accepts a well-formed FunctionDefinition', () => {
    expect(validateNode(fn)).toEqual(fn);
  });

  it('round-trips every canonical node type', () => {
    const nodes: SchemaNode[] = [
      sourceFile,
      fn,
      {
        nodeType: 'APIEndpoint',
        id: idFor.apiEndpoint({ repository: repo, httpMethod: 'GET', routePattern: '/users/:id', filePath: 'a.ts', lineStart: 1 }),
        httpMethod: 'GET',
        routePattern: '/users/:id',
        handlerFunctionId: fnId,
        framework: 'express',
        repository: repo,
      },
      {
        nodeType: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({ sourceFileId: fileId, sourceLine: 20, urlLiteral: '/users/1' }),
        functionId: fnId,
        sourceFileId: fileId,
        sourceLine: 20,
        httpMethod: 'GET',
        urlLiteral: '/users/1',
        egressConfidence: 'exact',
        framework: 'react',
        repository: repo,
      },
      {
        nodeType: 'ClientSideProcess',
        id: idFor.clientSideProcess({ sourceFileId: fileId, sourceLine: 30, name: 'onClick' }),
        kind: 'event_handler',
        name: 'onClick',
        functionId: fnId,
        sourceFileId: fileId,
        sourceLine: 30,
        framework: 'react',
        repository: repo,
      },
      {
        nodeType: 'DatabaseSystem',
        id: sysId,
        kind: 'postgres',
        name: 'main',
        connectionSource: 'DATABASE_URL',
      },
      {
        nodeType: 'DatabaseTable',
        id: tableId,
        systemId: sysId,
        name: 'users',
        schema: 'public',
        kind: 'table',
        declaredIn: 'prisma/schema.prisma',
      },
      {
        nodeType: 'DatabaseColumn',
        id: idFor.databaseColumn({ tableId, name: 'id' }),
        tableId,
        name: 'id',
        type: 'uuid',
        nullable: false,
        isPrimaryKey: true,
        isForeignKey: false,
      },
      {
        nodeType: 'DatabaseInteraction',
        id: interactionId,
        callSiteFunctionId: fnId,
        operation: 'read',
        orm: 'prisma',
        rawQuery: null,
        confidence: 'direct',
      },
    ];

    for (const node of nodes) {
      expect(validateNode(node)).toEqual(node);
    }
  });

  it('rejects an unknown nodeType', () => {
    expect(() => validateNode({ nodeType: 'NotAThing', id: 'x' })).toThrow(SchemaValidationError);
  });

  it('rejects a node with missing required fields', () => {
    expect(() => validateNode({ nodeType: 'SourceFile', id: 'x' })).toThrow(SchemaValidationError);
  });

  it('rejects a node with wrong field type', () => {
    expect(() =>
      validateNode({
        nodeType: 'FunctionDefinition',
        id: fnId,
        name: 'getUser',
        sourceFileId: fileId,
        sourceLine: 'not-a-number',
        parameters: [],
        returnType: null,
        isExported: true,
        isAsync: false,
      })
    ).toThrow(SchemaValidationError);
  });
});

describe('validateEdge', () => {
  it('round-trips every canonical edge type', () => {
    const edges: SchemaEdge[] = [
      { edgeType: 'IMPORTS', from: fileId, to: fileId, symbols: ['x'], isDefault: false, isDynamic: false },
      { edgeType: 'EXPORTS', from: fileId, to: fnId, exportName: 'getUser', isDefault: false },
      { edgeType: 'DEFINED_IN', from: fnId, to: fileId },
      {
        edgeType: 'CALLS_FUNCTION',
        from: fnId,
        to: fnId,
        sourceLine: 12,
        arguments: ['id'],
        isConditional: false,
        confidence: 'direct',
      },
      {
        edgeType: 'RESOLVES_TO_ENDPOINT',
        from: 'ClientSideAPICaller:abc',
        to: 'APIEndpoint:def',
        matchedBy: 'pattern',
        matchConfidence: 'high',
      },
      { edgeType: 'TABLE_IN', from: tableId, to: sysId },
      { edgeType: 'COLUMN_IN', from: 'DatabaseColumn:abc', to: tableId },
      {
        edgeType: 'FOREIGN_KEY',
        from: 'DatabaseColumn:abc',
        to: 'DatabaseColumn:def',
        onDelete: 'CASCADE',
        onUpdate: null,
      },
      { edgeType: 'READS', from: interactionId, to: tableId, columns: ['id', 'name'], filters: 'id = ?' },
      { edgeType: 'WRITES', from: interactionId, to: tableId, columns: null, kind: 'insert' },
      { edgeType: 'PERFORMED_BY', from: interactionId, to: fnId, sourceLine: 12 },
    ];

    for (const edge of edges) {
      expect(validateEdge(edge)).toEqual(edge);
    }
  });

  it('rejects an unknown edgeType', () => {
    expect(() => validateEdge({ edgeType: 'NOPE', from: 'a', to: 'b' })).toThrow(SchemaValidationError);
  });

  it('rejects an invalid call confidence', () => {
    expect(() =>
      validateEdge({
        edgeType: 'CALLS_FUNCTION',
        from: fnId,
        to: fnId,
        sourceLine: 1,
        arguments: [],
        isConditional: false,
        confidence: 'super-direct',
      })
    ).toThrow(SchemaValidationError);
  });
});

describe('validateBatch', () => {
  it('validates a mixed batch of nodes and edges', () => {
    const batch = validateBatch({
      nodes: [sourceFile, fn],
      edges: [{ edgeType: 'DEFINED_IN', from: fnId, to: fileId }],
    });
    expect(batch.nodes).toHaveLength(2);
    expect(batch.edges).toHaveLength(1);
  });

  it('throws on the first invalid node', () => {
    expect(() =>
      validateBatch({
        nodes: [sourceFile, { nodeType: 'Bogus' }],
        edges: [],
      })
    ).toThrow(SchemaValidationError);
  });

  // Gap 3: validateBatch error path depth
  it('throws when batch contains a valid node but an invalid edge', () => {
    expect(() =>
      validateBatch({
        nodes: [sourceFile],
        edges: [{ edgeType: 'NOT_REAL', from: 'a', to: 'b' }],
      })
    ).toThrow(SchemaValidationError);
  });

  it('accepts an empty batch and returns empty arrays', () => {
    const result = validateBatch({ nodes: [], edges: [] });
    expect(result).toEqual({ nodes: [], edges: [] });
  });

  it('preserves the input order of valid nodes and edges', () => {
    const apiEndpoint: SchemaNode = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({ repository: repo, httpMethod: 'GET', routePattern: '/a', filePath: 'a.ts', lineStart: 1 }),
      httpMethod: 'GET',
      routePattern: '/a',
      handlerFunctionId: null,
      framework: 'express',
      repository: repo,
    };
    const edges: SchemaEdge[] = [
      { edgeType: 'DEFINED_IN', from: fnId, to: fileId },
      { edgeType: 'EXPORTS', from: fileId, to: fnId, exportName: 'getUser', isDefault: false },
      { edgeType: 'IMPORTS', from: fileId, to: fileId, symbols: ['x'], isDefault: false, isDynamic: false },
    ];
    const result = validateBatch({
      nodes: [sourceFile, fn, apiEndpoint],
      edges,
    });
    expect(result.nodes.map((n) => n.id)).toEqual([sourceFile.id, fn.id, apiEndpoint.id]);
    expect(result.edges.map((e) => e.edgeType)).toEqual(['DEFINED_IN', 'EXPORTS', 'IMPORTS']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Gap 4: SchemaValidationError shape
// ──────────────────────────────────────────────────────────────────────
describe('SchemaValidationError shape', () => {
  it('has the expected properties when thrown by validateNode', () => {
    try {
      validateNode({ nodeType: 'SourceFile', id: 'x' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const sve = err as SchemaValidationError;
      expect(sve.name).toBe('SchemaValidationError');
      expect(Array.isArray(sve.issues)).toBe(true);
      expect((sve.issues as unknown[]).length).toBeGreaterThan(0);
      expect(typeof sve.message).toBe('string');
      expect(sve.message.length).toBeGreaterThan(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Gap 1: Systematic negative tests for every node type
// ──────────────────────────────────────────────────────────────────────
const validNodes: Record<string, SchemaNode> = {
  SourceFile: sourceFile,
  FunctionDefinition: fn,
  APIEndpoint: {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({ repository: repo, httpMethod: 'GET', routePattern: '/users/:id', filePath: 'a.ts', lineStart: 1 }),
    httpMethod: 'GET',
    routePattern: '/users/:id',
    handlerFunctionId: fnId,
    framework: 'express',
    repository: repo,
  },
  ClientSideAPICaller: {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({ sourceFileId: fileId, sourceLine: 20, urlLiteral: '/users/1' }),
    functionId: fnId,
    sourceFileId: fileId,
    sourceLine: 20,
    httpMethod: 'GET',
    urlLiteral: '/users/1',
    egressConfidence: 'exact',
    framework: 'react',
    repository: repo,
  },
  ClientSideProcess: {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({ sourceFileId: fileId, sourceLine: 30, name: 'onClick' }),
    kind: 'event_handler',
    name: 'onClick',
    functionId: fnId,
    sourceFileId: fileId,
    sourceLine: 30,
    framework: 'react',
    repository: repo,
  },
  DatabaseSystem: {
    nodeType: 'DatabaseSystem',
    id: sysId,
    kind: 'postgres',
    name: 'main',
    connectionSource: 'DATABASE_URL',
  },
  DatabaseTable: {
    nodeType: 'DatabaseTable',
    id: tableId,
    systemId: sysId,
    name: 'users',
    schema: 'public',
    kind: 'table',
    declaredIn: null,
  },
  DatabaseColumn: {
    nodeType: 'DatabaseColumn',
    id: idFor.databaseColumn({ tableId, name: 'id' }),
    tableId,
    name: 'id',
    type: 'uuid',
    nullable: false,
    isPrimaryKey: true,
    isForeignKey: false,
  },
  DatabaseInteraction: {
    nodeType: 'DatabaseInteraction',
    id: interactionId,
    callSiteFunctionId: fnId,
    operation: 'read',
    orm: 'prisma',
    rawQuery: null,
    confidence: 'direct',
  },
};

interface NodeMutation {
  nodeType: string;
  description: string;
  mutate: (node: Record<string, unknown>) => Record<string, unknown>;
}

const nodeMutations: NodeMutation[] = [
  {
    nodeType: 'SourceFile',
    description: 'missing required filePath',
    mutate: (n) => {
      const rest = { ...n };
      delete rest.filePath;
      return rest;
    },
  },
  {
    nodeType: 'FunctionDefinition',
    description: 'sourceLine wrong type',
    mutate: (n) => ({ ...n, sourceLine: 'twelve' }),
  },
  {
    nodeType: 'APIEndpoint',
    description: 'httpMethod wrong type',
    mutate: (n) => ({ ...n, httpMethod: 42 }),
  },
  {
    nodeType: 'ClientSideAPICaller',
    description: 'invalid egressConfidence enum',
    mutate: (n) => ({ ...n, egressConfidence: 'definitely-not' }),
  },
  {
    nodeType: 'ClientSideProcess',
    description: 'invalid kind enum',
    mutate: (n) => ({ ...n, kind: 'mystery' }),
  },
  {
    nodeType: 'DatabaseSystem',
    description: 'invalid kind enum',
    mutate: (n) => ({ ...n, kind: 'graphdb' }),
  },
  {
    nodeType: 'DatabaseTable',
    description: 'invalid kind enum',
    mutate: (n) => ({ ...n, kind: 'materialized_view' }),
  },
  {
    nodeType: 'DatabaseColumn',
    description: 'isPrimaryKey set to null (non-nullable)',
    mutate: (n) => ({ ...n, isPrimaryKey: null }),
  },
  {
    nodeType: 'DatabaseInteraction',
    description: 'invalid operation enum',
    mutate: (n) => ({ ...n, operation: 'truncate' }),
  },
];

describe('validateNode systematic negative tests', () => {
  it.each(nodeMutations)('rejects $nodeType with $description', ({ nodeType, mutate }) => {
    const valid = validNodes[nodeType];
    expect(valid).toBeDefined();
    const broken = mutate({ ...(valid as unknown as Record<string, unknown>) });
    expect(() => validateNode(broken)).toThrow(SchemaValidationError);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Gap 1 (continued): Systematic negative tests for every edge type
// ──────────────────────────────────────────────────────────────────────
const validEdges: Record<string, SchemaEdge> = {
  IMPORTS: { edgeType: 'IMPORTS', from: fileId, to: fileId, symbols: ['x'], isDefault: false, isDynamic: false },
  EXPORTS: { edgeType: 'EXPORTS', from: fileId, to: fnId, exportName: 'getUser', isDefault: false },
  DEFINED_IN: { edgeType: 'DEFINED_IN', from: fnId, to: fileId },
  CALLS_FUNCTION: {
    edgeType: 'CALLS_FUNCTION',
    from: fnId,
    to: fnId,
    sourceLine: 12,
    arguments: ['id'],
    isConditional: false,
    confidence: 'direct',
  },
  RESOLVES_TO_ENDPOINT: {
    edgeType: 'RESOLVES_TO_ENDPOINT',
    from: 'ClientSideAPICaller:abc',
    to: 'APIEndpoint:def',
    matchedBy: 'pattern',
    matchConfidence: 'high',
  },
  TABLE_IN: { edgeType: 'TABLE_IN', from: tableId, to: sysId },
  COLUMN_IN: { edgeType: 'COLUMN_IN', from: 'DatabaseColumn:abc', to: tableId },
  FOREIGN_KEY: {
    edgeType: 'FOREIGN_KEY',
    from: 'DatabaseColumn:abc',
    to: 'DatabaseColumn:def',
    onDelete: 'CASCADE',
    onUpdate: null,
  },
  READS: { edgeType: 'READS', from: interactionId, to: tableId, columns: ['id'], filters: null },
  WRITES: { edgeType: 'WRITES', from: interactionId, to: tableId, columns: null, kind: 'insert' },
  PERFORMED_BY: { edgeType: 'PERFORMED_BY', from: interactionId, to: fnId, sourceLine: 12 },
};

interface EdgeMutation {
  edgeType: string;
  description: string;
  mutate: (e: Record<string, unknown>) => Record<string, unknown>;
}

const edgeMutations: EdgeMutation[] = [
  {
    edgeType: 'IMPORTS',
    description: 'symbols wrong type',
    mutate: (e) => ({ ...e, symbols: 'not-an-array' }),
  },
  {
    edgeType: 'EXPORTS',
    description: 'missing exportName',
    mutate: (e) => {
      const rest = { ...e };
      delete rest.exportName;
      return rest;
    },
  },
  {
    edgeType: 'DEFINED_IN',
    description: 'missing from',
    mutate: (e) => {
      const rest = { ...e };
      delete rest.from;
      return rest;
    },
  },
  {
    edgeType: 'CALLS_FUNCTION',
    description: 'invalid confidence enum',
    mutate: (e) => ({ ...e, confidence: 'super-direct' }),
  },
  {
    edgeType: 'RESOLVES_TO_ENDPOINT',
    description: 'invalid matchedBy enum',
    mutate: (e) => ({ ...e, matchedBy: 'guess' }),
  },
  {
    edgeType: 'TABLE_IN',
    description: 'from set to null',
    mutate: (e) => ({ ...e, from: null }),
  },
  {
    edgeType: 'COLUMN_IN',
    description: 'to wrong type',
    mutate: (e) => ({ ...e, to: 99 }),
  },
  {
    edgeType: 'FOREIGN_KEY',
    description: 'onDelete wrong type',
    mutate: (e) => ({ ...e, onDelete: 12 }),
  },
  {
    edgeType: 'READS',
    description: 'columns wrong type (string instead of array|null)',
    mutate: (e) => ({ ...e, columns: 'all' }),
  },
  {
    edgeType: 'WRITES',
    description: 'invalid kind enum',
    mutate: (e) => ({ ...e, kind: 'truncate' }),
  },
  {
    edgeType: 'PERFORMED_BY',
    description: 'negative sourceLine',
    mutate: (e) => ({ ...e, sourceLine: -1 }),
  },
];

describe('validateEdge systematic negative tests', () => {
  it.each(edgeMutations)('rejects $edgeType with $description', ({ edgeType, mutate }) => {
    const valid = validEdges[edgeType];
    expect(valid).toBeDefined();
    const broken = mutate({ ...(valid as unknown as Record<string, unknown>) });
    expect(() => validateEdge(broken)).toThrow(SchemaValidationError);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Gap 2: Enum exhaustiveness round-trip
// ──────────────────────────────────────────────────────────────────────
describe('enum exhaustiveness', () => {
  describe.each([
    'direct',
    'method',
    'indirect',
    'dynamic',
  ] as const)('CallConfidence: %s', (variant) => {
    it('round-trips', () => {
      const edge = { ...validEdges.CALLS_FUNCTION, confidence: variant };
      expect(validateEdge(edge)).toEqual(edge);
    });
  });

  describe.each(['exact', 'pattern', 'dynamic'] as const)('HttpEgressConfidence: %s', (variant) => {
    it('round-trips', () => {
      const node = { ...validNodes.ClientSideAPICaller, egressConfidence: variant };
      expect(validateNode(node)).toEqual(node);
    });
  });

  describe.each([
    'ui_action',
    'event_handler',
    'lifecycle_hook',
    'state_observer',
    'timer',
    'browser_event',
    'cli_command',
    'script_entry',
    'bridge_command',
    'other',
  ] as const)('ProcessKind: %s', (variant) => {
    it('round-trips', () => {
      const node = { ...validNodes.ClientSideProcess, kind: variant };
      expect(validateNode(node)).toEqual(node);
    });
  });

  describe.each([
    'postgres',
    'mysql',
    'sqlite',
    'mssql',
    'oracle',
    'mongodb',
    'redis',
    'memcached',
    'dynamodb',
    'cassandra',
    'elasticsearch',
    'other',
  ] as const)('DatabaseKind: %s', (variant) => {
    it('round-trips', () => {
      const node = { ...validNodes.DatabaseSystem, kind: variant };
      expect(validateNode(node)).toEqual(node);
    });
  });

  describe.each(['table', 'view', 'collection'] as const)('DatabaseTableKind: %s', (variant) => {
    it('round-trips', () => {
      const node = { ...validNodes.DatabaseTable, kind: variant };
      expect(validateNode(node)).toEqual(node);
    });
  });

  describe.each(['read', 'write', 'update', 'delete', 'upsert', 'raw'] as const)(
    'DatabaseOperation: %s',
    (variant) => {
      it('round-trips', () => {
        const node = { ...validNodes.DatabaseInteraction, operation: variant };
        expect(validateNode(node)).toEqual(node);
      });
    }
  );

  describe.each(['direct', 'inferred', 'dynamic'] as const)(
    'DatabaseInteractionConfidence: %s',
    (variant) => {
      it('round-trips', () => {
        const node = { ...validNodes.DatabaseInteraction, confidence: variant };
        expect(validateNode(node)).toEqual(node);
      });
    }
  );

  describe.each(['exact-url', 'pattern', 'inferred'] as const)('ResolvesMatchedBy: %s', (variant) => {
    it('round-trips', () => {
      const edge = { ...validEdges.RESOLVES_TO_ENDPOINT, matchedBy: variant };
      expect(validateEdge(edge)).toEqual(edge);
    });
  });

  describe.each(['high', 'medium', 'low'] as const)('MatchConfidence: %s', (variant) => {
    it('round-trips', () => {
      const edge = { ...validEdges.RESOLVES_TO_ENDPOINT, matchConfidence: variant };
      expect(validateEdge(edge)).toEqual(edge);
    });
  });

  describe.each(['insert', 'update', 'upsert', 'delete'] as const)('WritesKind: %s', (variant) => {
    it('round-trips', () => {
      const edge = { ...validEdges.WRITES, kind: variant };
      expect(validateEdge(edge)).toEqual(edge);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Gap 5: Discriminated union actually discriminates
// ──────────────────────────────────────────────────────────────────────
describe('discriminated union nodeType/edgeType swaps', () => {
  it('rejects an APIEndpoint shape with nodeType swapped to SourceFile', () => {
    const swapped = { ...validNodes.APIEndpoint, nodeType: 'SourceFile' };
    expect(() => validateNode(swapped)).toThrow(SchemaValidationError);
  });

  it('rejects a DatabaseColumn shape with nodeType swapped to DatabaseSystem', () => {
    const swapped = { ...validNodes.DatabaseColumn, nodeType: 'DatabaseSystem' };
    expect(() => validateNode(swapped)).toThrow(SchemaValidationError);
  });

  it('rejects a READS edge with edgeType swapped to CALLS_FUNCTION', () => {
    const swapped = { ...validEdges.READS, edgeType: 'CALLS_FUNCTION' };
    expect(() => validateEdge(swapped)).toThrow(SchemaValidationError);
  });

  it('rejects a DEFINED_IN edge with edgeType swapped to FOREIGN_KEY', () => {
    // FOREIGN_KEY requires onDelete and onUpdate which DEFINED_IN lacks.
    const swapped = { ...validEdges.DEFINED_IN, edgeType: 'FOREIGN_KEY' };
    expect(() => validateEdge(swapped)).toThrow(SchemaValidationError);
  });
});
