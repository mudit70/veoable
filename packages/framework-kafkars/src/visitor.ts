import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@adorable/schema';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@adorable/lang-rust';

/**
 * rdkafka (Rust) visitor.
 *
 * Two detection paths share the visitor:
 *
 * 1. `FutureRecord::to("topic")` and `BaseRecord::to("topic")`
 *    — producer side. The call's function is a `scoped_identifier`
 *    with path = the record type and name = `to`. First arg is the
 *    topic string literal.
 *
 * 2. `<recv>.subscribe(&["t1", "t2"])` — consumer side. The call's
 *    function is a `field_expression` whose `field` is `subscribe`.
 *    The arg is a `reference_expression` wrapping an `array_expression`
 *    of string literals.
 *
 * Per-file gate: `use rdkafka` (or any nested rdkafka import). Without
 * this, unrelated `to()`/`subscribe()` calls in files that happen to
 * share a project with rdkafka would falsely emit.
 */

const PRODUCER_TYPES: ReadonlySet<string> = new Set(['FutureRecord', 'BaseRecord']);

export function createKafkarsVisitor(): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = hasCrateImport(root, 'rdkafka');
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn) return;

      // ── Producer: FutureRecord::to("topic") / BaseRecord::to("topic") ──
      // Also accept fully-qualified forms:
      //   `rdkafka::producer::FutureRecord::to("...")` — the path text
      //   becomes `rdkafka::producer::FutureRecord`, so match on the
      //   trailing segment instead of an exact `path.text` compare.
      if (fn.type === 'scoped_identifier') {
        const path = fn.childForFieldName('path');
        const name = fn.childForFieldName('name');
        if (!path || !name) return;
        if (!isProducerRecordPath(path.text)) return;
        if (name.text !== 'to') return;
        const args = node.childForFieldName('arguments');
        if (!args) return;
        const topic = firstStringArg(args);
        if (topic === null) return;
        emitCaller(ctx, node, topic);
        return;
      }

      // ── Consumer: <recv>.subscribe(&["t1", "t2"]) ─────────────
      if (fn.type === 'field_expression') {
        const field = fn.childForFieldName('field');
        if (!field || field.text !== 'subscribe') return;
        const args = node.childForFieldName('arguments');
        if (!args) return;
        const topics = subscribeTopics(args);
        if (topics.length === 0) return;
        for (const topic of topics) emitEndpoint(ctx, node, topic);
        return;
      }
    },
  };
}

/**
 * Extract topic literals from a `subscribe(&[...])` arg list.
 * Walks the first arg (which is a `reference_expression` wrapping an
 * `array_expression`) for string-literal elements.
 */
function subscribeTopics(args: SyntaxNode): string[] {
  const first = nthArg(args, 0);
  if (!first) return [];
  // Peel `&` (reference_expression) → expression
  let inner = first;
  if (inner.type === 'reference_expression') {
    const v = inner.childForFieldName('value') ?? inner.namedChild(0);
    if (v) inner = v;
  }
  if (inner.type !== 'array_expression') return [];

  const out: string[] = [];
  for (let i = 0; i < inner.childCount; i++) {
    const c = inner.child(i);
    if (!c) continue;
    if (c.type !== 'string_literal' && c.type !== 'raw_string_literal') continue;
    const s = stripRustString(c.text);
    if (s !== null) out.push(s);
  }
  return out;
}

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'string_literal' || c.type === 'raw_string_literal') {
      return stripRustString(c.text);
    }
    return null;
  }
  return null;
}

/**
 * Match the scoped_identifier's path against the known rdkafka
 * record types. Accepts both the bare name (`FutureRecord`, after
 * `use rdkafka::producer::FutureRecord`) and the fully-qualified
 * form (`rdkafka::producer::FutureRecord`) by checking the trailing
 * segment after the last `::`.
 */
function isProducerRecordPath(pathText: string): boolean {
  const lastSep = pathText.lastIndexOf('::');
  const trailing = lastSep === -1 ? pathText : pathText.slice(lastSep + 2);
  return PRODUCER_TYPES.has(trailing);
}

function nthArg(args: SyntaxNode, index: number): SyntaxNode | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === index) return c;
    seen++;
  }
  return null;
}

function stripRustString(text: string): string | null {
  // Drop the `b` byte-string prefix if present.
  let s = text;
  if (s.startsWith('b') || s.startsWith('B')) s = s.slice(1);
  // Raw strings: `r"..."` / `r#"..."#`
  if (s.startsWith('r')) {
    const hashes = /^r(#*)"/.exec(s);
    if (hashes) {
      const h = hashes[1].length;
      const closer = '"' + '#'.repeat(h);
      const start = 1 + h + 1; // r + hashes + opening quote
      if (s.endsWith(closer)) return s.slice(start, s.length - closer.length);
    }
    return null;
  }
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return null;
}

function emitEndpoint(ctx: RustVisitContext, evidenceNode: SyntaxNode, topic: string): void {
  const routePattern = `kafka:${topic}`;
  const evidenceLine = evidenceNode.startPosition.row + 1;
  const handlerFunctionId = ctx.enclosingFunction?.id ?? null;

  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'JOB',
      routePattern,
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
    }),
    httpMethod: 'JOB',
    routePattern,
    handlerFunctionId,
    framework: 'kafkars',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
      lineEnd: evidenceNode.endPosition.row + 1,
      snippet: evidenceNode.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(endpoint);
}

function emitCaller(ctx: RustVisitContext, callNode: SyntaxNode, topic: string): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = callNode.startPosition.row + 1;
  const urlLiteral = `kafka:${topic}`;

  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      urlLiteral,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    httpMethod: 'JOB',
    urlLiteral,
    egressConfidence: 'exact',
    framework: 'kafkars',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: sourceLine,
      lineEnd: callNode.endPosition.row + 1,
      snippet: callNode.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(caller);
  ctx.emitEdge({
    edgeType: 'MAKES_REQUEST',
    from: ctx.enclosingFunction.id,
    to: caller.id,
  });
}
