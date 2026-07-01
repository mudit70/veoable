import { Node, type Expression, type SourceFile } from 'ts-morph';

/**
 * Partial constant evaluator for bundler config files (#197).
 *
 * Resolves a small subset of expressions to a concrete string:
 *   - String literal / no-substitution template.
 *   - Template literal with statically-resolvable spans.
 *   - `path.resolve(arg, arg, ...)` / `path.join(arg, arg, ...)` of
 *     statically-resolvable args (POSIX-style join).
 *   - Identifier referring to a top-level `const`, `let`, or `var`
 *     declaration in the same file whose initializer is itself
 *     statically resolvable (recursive, with depth cap).
 *   - `__dirname` / `import.meta.dirname` → empty string sentinel
 *     (the rootDir-relative path is what the caller wants; we don't
 *     hard-code an absolute prefix here).
 *
 * Anything else returns null.
 */

const MAX_RECURSION_DEPTH = 8;

export function evalConstant(expr: Expression): string | null {
  return evalConstantWithDepth(expr, 0);
}

function evalConstantWithDepth(expr: Expression, depth: number): string | null {
  if (depth > MAX_RECURSION_DEPTH) return null;

  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getLiteralValue();
  }

  if (Node.isTemplateExpression(expr)) {
    let result = expr.getHead().getLiteralText();
    for (const span of expr.getTemplateSpans()) {
      const inner = span.getExpression();
      const part = evalConstantWithDepth(inner, depth + 1);
      if (part === null) return null;
      result += part;
      // ts-morph's TemplateSpan.getLiteral() returns the literal
      // tail — types vary by ts-morph version; getLiteralText covers
      // both `MiddleLiteral` and `TailLiteral`.
      result += span.getLiteral().getLiteralText();
    }
    return result;
  }

  if (Node.isIdentifier(expr)) {
    const text = expr.getText();
    if (text === '__dirname') return '';
    // Resolve via symbol → declaration → initializer (same file only).
    const sym = expr.getSymbol();
    if (!sym) return null;
    for (const d of sym.getDeclarations()) {
      if (!Node.isVariableDeclaration(d)) continue;
      const init = d.getInitializer();
      if (!init) continue;
      // Same-file gate.
      if (d.getSourceFile() !== expr.getSourceFile()) return null;
      return evalConstantWithDepth(init, depth + 1);
    }
    return null;
  }

  if (Node.isPropertyAccessExpression(expr)) {
    // `import.meta.dirname` → empty sentinel.
    const text = expr.getText();
    if (text === 'import.meta.dirname' || text === 'import.meta.url') return '';
    return null;
  }

  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    let calleeText = '';
    if (Node.isIdentifier(callee)) calleeText = callee.getText();
    else if (Node.isPropertyAccessExpression(callee)) calleeText = callee.getText();
    else return null;

    // path.resolve(...) / path.join(...) — same semantics for our
    // purposes: concatenate POSIX-joined string arguments.
    if (
      calleeText === 'path.resolve' ||
      calleeText === 'path.join' ||
      calleeText === 'resolve' ||
      calleeText === 'join'
    ) {
      const args = expr.getArguments();
      const parts: string[] = [];
      for (const a of args) {
        if (!Node.isStringLiteral(a) && !Node.isNoSubstitutionTemplateLiteral(a) && !Node.isTemplateExpression(a) && !Node.isIdentifier(a) && !Node.isPropertyAccessExpression(a) && !Node.isCallExpression(a)) {
          return null;
        }
        const part = evalConstantWithDepth(a as Expression, depth + 1);
        if (part === null) return null;
        if (part === '') continue;
        parts.push(part);
      }
      return joinPosix(parts);
    }
  }

  return null;
}

/**
 * Concatenate path segments with `/` separators, collapsing repeats
 * and stripping trailing slashes. Mirrors `path.posix.join`.
 */
function joinPosix(parts: string[]): string {
  if (parts.length === 0) return '';
  const joined = parts
    .map((p, i) => (i === 0 ? p : p.replace(/^\/+/, '')))
    .map((p, i, arr) => (i === arr.length - 1 ? p : p.replace(/\/+$/, '')))
    .join('/');
  return joined.replace(/\/{2,}/g, '/');
}
