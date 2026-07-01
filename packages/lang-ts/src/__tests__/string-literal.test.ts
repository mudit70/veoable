import { describe, expect, it } from 'vitest';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { readStringLiteral } from '../string-literal.js';

function firstCallArg(source: string): Node | undefined {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('t.ts', source);
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    return call.getArguments()[0];
  }
  return undefined;
}

describe('readStringLiteral', () => {
  it('returns the value for a plain string literal', () => {
    const node = firstCallArg(`fn('hello world');`);
    expect(readStringLiteral(node)).toBe('hello world');
  });

  it('returns the value for a no-substitution template literal', () => {
    const node = firstCallArg(`fn(\`backtick string\`);`);
    expect(readStringLiteral(node)).toBe('backtick string');
  });

  it('returns null for a template literal with substitution', () => {
    const node = firstCallArg(`const x = 1; fn(\`pre-\${x}-post\`);`);
    expect(readStringLiteral(node)).toBeNull();
  });

  it('returns null for an identifier (variable reference)', () => {
    const node = firstCallArg(`const name = 'a'; fn(name);`);
    expect(readStringLiteral(node)).toBeNull();
  });

  it('returns null for a number literal', () => {
    const node = firstCallArg(`fn(42);`);
    expect(readStringLiteral(node)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(readStringLiteral(undefined)).toBeNull();
  });

  it('returns the empty string for an empty literal (not null)', () => {
    // Important: callers like framework-bullmq's `.add()` job-name
    // guard distinguish "wasn't a literal" (skip) from "was the
    // empty-string literal" (still skip via `!queueName`). The
    // helper must return '' so future callers that genuinely want
    // empty strings can also see them.
    const node = firstCallArg(`fn('');`);
    expect(readStringLiteral(node)).toBe('');
  });

  it('returns null for a tagged template literal', () => {
    // The CallExpression's first arg here is the *template*, not
    // a literal — the call is `tag\`foo\``. From a static-analysis
    // standpoint the value depends on the tag function, so we
    // refuse to read it.
    const node = firstCallArg(`function tag(strs: TemplateStringsArray) { return strs[0]; }
fn(tag\`foo\`);`);
    expect(readStringLiteral(node)).toBeNull();
  });
});
