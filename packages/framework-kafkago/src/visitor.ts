import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@adorable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';

/**
 * Kafka (Go) visitor.
 *
 * Two detection paths share the visitor:
 *
 * 1. composite_literal scan — the segmentio/kafka-go and sarama
 *    libraries both express producer/consumer config as struct
 *    literals with a `Topic: "..."` field:
 *
 *      kafka.WriterConfig{Brokers: ..., Topic: "user-events"}   // producer
 *      kafka.Writer{Addr: ..., Topic: "user-events"}            // producer
 *      kafka.Message{Topic: "user-events", Value: ...}          // producer (per-msg override)
 *      sarama.ProducerMessage{Topic: "user-events", ...}        // producer
 *      kafka.ReaderConfig{Brokers: ..., Topic: "user-events"}   // consumer
 *      kafka.Reader{...}                                        // (consumer; topic via ReaderConfig)
 *
 * 2. call_expression scan — sarama exposes one-shot APIs:
 *
 *      consumer.ConsumePartition("user-events", 0, ...)         // consumer
 *
 * Both paths share the same per-file gate: the file must `import`
 * one of the kafka modules so unrelated `Topic:` fields elsewhere
 * (e.g. configuration packages) are never matched.
 */

/**
 * Resolved per-file: which package aliases the source uses for the
 * kafka modules. Built once per file from its `import` block.
 *
 *   import "github.com/segmentio/kafka-go"          → kafka  → 'kafka'
 *   import segkafka "github.com/segmentio/kafka-go" → kafka  → 'segkafka'
 *   import "github.com/IBM/sarama"                  → sarama → 'sarama'
 *
 * The PRODUCER_TYPES / CONSUMER_TYPES sets are built per-file using
 * these aliases so e.g. `segkafka.WriterConfig{...}` matches when
 * the file aliases segmentio under `segkafka`.
 */
interface KafkaImports {
  // Canonical-package-name → alias-used-in-source.
  // Empty when the file imports nothing kafka-related.
  aliases: Map<string, string>;
}

interface TypeSets {
  producer: ReadonlySet<string>;
  consumer: ReadonlySet<string>;
}

function buildTypeSets(imports: KafkaImports): TypeSets {
  const producer = new Set<string>();
  const consumer = new Set<string>();
  const kafkaAlias = imports.aliases.get('kafka');
  if (kafkaAlias) {
    producer.add(`${kafkaAlias}.WriterConfig`);
    producer.add(`${kafkaAlias}.Writer`);
    producer.add(`${kafkaAlias}.Message`);
    consumer.add(`${kafkaAlias}.ReaderConfig`);
    consumer.add(`${kafkaAlias}.Reader`);
  }
  const saramaAlias = imports.aliases.get('sarama');
  if (saramaAlias) {
    producer.add(`${saramaAlias}.ProducerMessage`);
  }
  return { producer, consumer };
}

export function createKafkagoVisitor(): GoFrameworkVisitor {
  const importsByFile = new Map<string, KafkaImports>();
  const typeSetsByFile = new Map<string, TypeSets>();
  const getImports = (filePath: string, root: SyntaxNode): KafkaImports => {
    let imports = importsByFile.get(filePath);
    if (imports === undefined) {
      imports = scanFileImports(root);
      importsByFile.set(filePath, imports);
      typeSetsByFile.set(filePath, buildTypeSets(imports));
    }
    return imports;
  };

  return {
    language: 'go',
    onNode(ctx, node) {
      const imports = getImports(ctx.sourceFile.filePath, node.tree.rootNode);
      if (imports.aliases.size === 0) return;

      if (node.type === 'composite_literal') {
        const sets = typeSetsByFile.get(ctx.sourceFile.filePath);
        if (sets) handleCompositeLiteral(ctx, node, sets);
        return;
      }
      if (node.type === 'call_expression') {
        handleCall(ctx, node);
        return;
      }
    },
  };
}

function handleCompositeLiteral(ctx: GoVisitContext, node: SyntaxNode, sets: TypeSets): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const t = typeNode.text;

  const isProducer = sets.producer.has(t);
  const isConsumer = sets.consumer.has(t);
  if (!isProducer && !isConsumer) return;

  const topic = extractTopicLiteral(node.text);
  if (topic === null) return;

  if (isProducer) {
    emitCaller(ctx, node, topic);
  } else {
    emitEndpoint(ctx, node, topic);
  }
}

function handleCall(ctx: GoVisitContext, node: SyntaxNode): void {
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'selector_expression') return;
  const field = fn.childForFieldName('field');
  if (!field) return;

  // sarama: `consumer.ConsumePartition("user-events", 0, offset)`
  if (field.text !== 'ConsumePartition') return;

  const args = node.childForFieldName('arguments');
  if (!args) return;
  const topic = firstStringArg(args);
  if (topic === null) return;

  emitEndpoint(ctx, node, topic);
}

/**
 * Find `Topic: "literal"` in a composite-literal source text. Tolerate
 * trailing-comma form `Topic: "x",`. Returns null when the value is
 * an identifier / expression / variable.
 */
function extractTopicLiteral(text: string): string | null {
  const re = /\bTopic\s*:\s*"([^"]*)"/;
  const m = re.exec(text);
  return m ? m[1] : null;
}

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
      return stripGoString(c.text);
    }
    // Stop on the first non-skip arg — if it isn't a literal, give up.
    return null;
  }
  return null;
}

function stripGoString(text: string): string {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function emitEndpoint(ctx: GoVisitContext, evidenceNode: SyntaxNode, topic: string): void {
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
    framework: 'kafkago',
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

function emitCaller(ctx: GoVisitContext, callNode: SyntaxNode, topic: string): void {
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
    framework: 'kafkago',
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

/**
 * Walk every `import_spec` in the file. For each spec, look at the
 * `path` text (the quoted module URL) and the optional `name` field
 * (the local alias) to build the canonical → alias map.
 *
 * Without an explicit alias, the local name is the package's own
 * declared name — `kafka` for `segmentio/kafka-go`, `sarama` for the
 * `sarama` libraries.
 */
function scanFileImports(rootNode: SyntaxNode): KafkaImports {
  const aliases = new Map<string, string>();
  const visitSpec = (spec: SyntaxNode): void => {
    const pathNode = spec.childForFieldName('path');
    if (!pathNode) return;
    const path = pathNode.text;
    const nameNode = spec.childForFieldName('name');
    const localName = nameNode?.text;
    if (path.includes('github.com/segmentio/kafka-go')) {
      aliases.set('kafka', localName ?? 'kafka');
    } else if (
      path.includes('github.com/IBM/sarama')
      || path.includes('github.com/Shopify/sarama')
    ) {
      aliases.set('sarama', localName ?? 'sarama');
    }
  };
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'import_spec') visitSpec(n);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type === 'import_declaration') walk(c);
  }
  return { aliases };
}
