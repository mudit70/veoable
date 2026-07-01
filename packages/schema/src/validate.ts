import { SchemaNodeSchema, type SchemaNode } from './nodes.js';
import { SchemaEdgeSchema, type SchemaEdge } from './edges.js';

/**
 * Runtime validators. Plugins should call these in tests (and may call
 * them in dev) to catch shape errors at the boundary. Production
 * extraction runs may skip validation for speed.
 */

export class SchemaValidationError extends Error {
  constructor(message: string, readonly issues: unknown) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export function validateNode(node: unknown): SchemaNode {
  const result = SchemaNodeSchema.safeParse(node);
  if (!result.success) {
    throw new SchemaValidationError(`Invalid node: ${result.error.message}`, result.error.issues);
  }
  return result.data;
}

export function validateEdge(edge: unknown): SchemaEdge {
  const result = SchemaEdgeSchema.safeParse(edge);
  if (!result.success) {
    throw new SchemaValidationError(`Invalid edge: ${result.error.message}`, result.error.issues);
  }
  return result.data;
}

export interface NodeBatch {
  nodes: SchemaNode[];
  edges: SchemaEdge[];
}

export function validateBatch(batch: { nodes: unknown[]; edges: unknown[] }): NodeBatch {
  return {
    nodes: batch.nodes.map(validateNode),
    edges: batch.edges.map(validateEdge),
  };
}
