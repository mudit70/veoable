import type { Node } from 'ts-morph';
import type { SourceEvidence } from '@adorable/schema';

const MAX_SNIPPET_LENGTH = 500;

/**
 * Build a `SourceEvidence` object from a ts-morph AST node.
 *
 * Framework visitors and the structural extractor call this to attach
 * provenance metadata to every emitted node. The snippet is truncated
 * to {@link MAX_SNIPPET_LENGTH} characters to keep serialized graph
 * sizes reasonable.
 */
export function buildEvidence(
  node: Node,
  filePath: string,
  confidence: SourceEvidence['confidence'] = 'exact'
): SourceEvidence {
  const text = node.getText();
  return {
    filePath,
    lineStart: node.getStartLineNumber(),
    lineEnd: node.getEndLineNumber(),
    snippet: text.length > MAX_SNIPPET_LENGTH ? text.slice(0, MAX_SNIPPET_LENGTH - 1) + '…' : text,
    confidence,
  };
}
