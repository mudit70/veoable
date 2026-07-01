import { Node } from 'ts-morph';

/**
 * Read a string-literal value out of a ts-morph node, returning the
 * value or `null` if the node isn't a literal we can safely read.
 *
 * Accepts:
 *   - `'foo'`, `"foo"`             → StringLiteral
 *   - `` `foo` ``                  → NoSubstitutionTemplateLiteral
 *
 * Rejects:
 *   - `` `pre-${x}-post` ``        — template with substitution; the
 *     caller needs constant propagation to know what it resolves to.
 *   - Anything else (identifier, expression, undefined node).
 *
 * Used by framework visitors that need the literal argument of a call
 * (queue name, route, MCP tool name, ...). Centralized here so the
 * accept/reject set stays consistent across plugins — see CLAUDE.md
 * architecture rule #1: cross-cutting helpers belong in lang-ts, not
 * duplicated across framework plugins.
 */
export function readStringLiteral(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return null;
}
