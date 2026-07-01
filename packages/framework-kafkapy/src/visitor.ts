import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

/**
 * Kafka (Python) visitor.
 *
 * Producer detection (→ ClientSideAPICaller, `kafka:<topic>`):
 *   <p>.send('topic', value=b'...')        — kafka-python
 *   <p>.send(topic='topic', value=...)     — kafka-python kwarg
 *   <p>.produce('topic', value=b'...')     — confluent-kafka
 *
 * Consumer detection (→ APIEndpoint, `kafka:<topic>`, handlerFunctionId
 * = enclosing function):
 *   KafkaConsumer('topic1', 'topic2', ...)            — kafka-python
 *   Consumer({...}).subscribe(['topic'])              — confluent-kafka
 *   <c>.subscribe(['topic1', 'topic2'])
 *   <c>.subscribe(topics=['topic1'])
 *
 * Per-file activation gate: any `kafka`, `confluent_kafka`, or
 * `aiokafka` import. Avoids emitting in files that share a project
 * with kafka but don't actually use it.
 */

const PRODUCER_VERBS: ReadonlySet<string> = new Set([
  // kafka-python / confluent-kafka
  'send',
  'produce',
  // aiokafka — async wrappers with the same call shape:
  // `AIOKafkaProducer.send_and_wait('topic', value=...)` and
  // `.send_batch('topic', batch, ...)`. Without these, the dominant
  // async producer surface is silently missed.
  'send_and_wait',
  'send_batch',
]);
const CONSUMER_CTORS: ReadonlySet<string> = new Set([
  'KafkaConsumer',
  'AIOKafkaConsumer',
]);

export function createKafkapyVisitor(): PyFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = scanFileImportsKafka(root);
    importsByFile.set(filePath, v);
    return v;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;
      handleCall(ctx, node);
    },
  };
}

function handleCall(ctx: PyVisitContext, node: SyntaxNode): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  const args = node.childForFieldName('arguments');
  if (!args) return;

  // ── KafkaConsumer('t1', 't2', ...) ─────────────────────────
  // The function is either `KafkaConsumer` (bare) or `kafka.KafkaConsumer`
  // (attribute). Match the leaf name.
  const leafName = leafCalleeName(fn);
  if (leafName && CONSUMER_CTORS.has(leafName)) {
    const topics = positionalStringArgs(args);
    for (const topic of topics) emitEndpoint(ctx, node, topic);
    return;
  }

  // ── <recv>.<verb>(...) ────────────────────────────────────
  if (fn.type !== 'attribute') return;
  const attr = fn.childForFieldName('attribute');
  if (!attr) return;
  const methodName = attr.text;

  // Producer: .send(topic, ...) / .produce(topic, ...)
  if (PRODUCER_VERBS.has(methodName)) {
    const topic = firstStringArg(args) ?? findKwarg(args, 'topic');
    if (topic === null) return;
    emitCaller(ctx, node, topic);
    return;
  }

  // Consumer: .subscribe([t1, t2]) / .subscribe(topics=[t1])
  if (methodName === 'subscribe') {
    const topics
      = listLiteralStrings(firstNonStringArg(args))
      ?? listLiteralStrings(findKwargNode(args, 'topics'))
      ?? [];
    for (const topic of topics) emitEndpoint(ctx, node, topic);
    return;
  }
}

function leafCalleeName(fn: SyntaxNode): string | null {
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') return fn.childForFieldName('attribute')?.text ?? null;
  return null;
}

function positionalStringArgs(args: SyntaxNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    if (c.type === 'string' || c.type === 'concatenated_string') {
      const s = stripPythonString(c.text);
      if (s !== null) out.push(s);
    }
  }
  return out;
}

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === 'string' || c.type === 'concatenated_string') {
      return stripPythonString(c.text);
    }
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    return null;
  }
  return null;
}

function firstNonStringArg(args: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    return c;
  }
  return null;
}

function findKwarg(args: SyntaxNode, name: string): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c || c.type !== 'keyword_argument') continue;
    const nameNode = c.childForFieldName('name');
    const valueNode = c.childForFieldName('value');
    if (nameNode?.text !== name) continue;
    if (valueNode?.type === 'string') return stripPythonString(valueNode.text);
  }
  return null;
}

function findKwargNode(args: SyntaxNode, name: string): SyntaxNode | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c || c.type !== 'keyword_argument') continue;
    const nameNode = c.childForFieldName('name');
    if (nameNode?.text !== name) continue;
    return c.childForFieldName('value');
  }
  return null;
}

function listLiteralStrings(node: SyntaxNode | null): string[] | null {
  if (!node) return null;
  if (node.type !== 'list' && node.type !== 'tuple' && node.type !== 'set') return null;
  const out: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'string' || c.type === 'concatenated_string') {
      const s = stripPythonString(c.text);
      if (s !== null) out.push(s);
    }
  }
  return out;
}

function stripPythonString(text: string): string | null {
  let s = text;
  if (/^[rRbBuU]*[fF]/.test(s)) return null;
  s = s.replace(/^[rRbBuU]+/, '');
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return null;
}

function emitEndpoint(ctx: PyVisitContext, evidenceNode: SyntaxNode, topic: string): void {
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
    framework: 'kafkapy',
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

function emitCaller(ctx: PyVisitContext, callNode: SyntaxNode, topic: string): void {
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
    framework: 'kafkapy',
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

function scanFileImportsKafka(root: SyntaxNode): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (!c) continue;
    if (c.type === 'import_statement' || c.type === 'import_from_statement') {
      const t = c.text;
      if (/\bkafka\b/.test(t) || /\bconfluent_kafka\b/.test(t) || /\baiokafka\b/.test(t)) {
        return true;
      }
    }
  }
  return false;
}
