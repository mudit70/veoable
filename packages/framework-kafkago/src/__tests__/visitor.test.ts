import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  APIEndpoint,
  ClientSideAPICaller,
  SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { KafkagoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/kafkago/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new KafkagoPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-kafkago visitor', () => {
  it('emits a producer for each Writer / Message composite literal', async () => {
    const batch = await extract('segmentio.go');
    // newWriterConfig: kafka.WriterConfig (1)
    // newWriterStruct: kafka.Writer (1)
    // writePerMessage: kafka.Message (1)
    // = 3
    expect(callers(batch).length).toBe(3);
  });

  it('emits a consumer for each ReaderConfig composite literal', async () => {
    const batch = await extract('segmentio.go');
    // newReader: kafka.ReaderConfig (1)
    // newReaderDynamic: no literal → skipped
    expect(endpoints(batch).length).toBe(1);
  });

  it('extracts the Topic literal from segmentio Writer/Reader configs', async () => {
    const batch = await extract('segmentio.go');
    const cu = callers(batch).map((c) => c.urlLiteral);
    const eu = endpoints(batch).map((e) => e.routePattern);
    expect(cu).toContain('kafka:user-events');
    expect(cu).toContain('kafka:order-events');
    expect(cu).toContain('kafka:payments');
    expect(eu).toContain('kafka:user-events');
  });

  it('every producer carries framework="kafkago" and JOB method', async () => {
    const batch = await extract('segmentio.go');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('kafkago');
      expect(c.httpMethod).toBe('JOB');
      expect(c.egressConfidence).toBe('exact');
    }
  });

  it('emits a producer for sarama.ProducerMessage composite literal', async () => {
    const batch = await extract('sarama.go');
    const cu = callers(batch).map((c) => c.urlLiteral);
    expect(cu).toContain('kafka:notifications');
  });

  it('emits a consumer for sarama consumer.ConsumePartition("topic", ...)', async () => {
    const batch = await extract('sarama.go');
    const eu = endpoints(batch).map((e) => e.routePattern);
    expect(eu).toContain('kafka:audit-log');
  });

  it('skips ConsumePartition with a dynamic topic variable', async () => {
    const batch = await extract('sarama.go');
    // sendProducerMessage caller + consumePartition endpoint = 2
    // (consumePartitionDynamic is dropped)
    expect(callers(batch).length + endpoints(batch).length).toBe(2);
    // Stronger guard: the regex must not have captured the identifier
    // text as a literal topic.
    const allUrls = [
      ...callers(batch).map((c) => c.urlLiteral),
      ...endpoints(batch).map((e) => e.routePattern),
    ];
    expect(allUrls).not.toContain('kafka:topic');
  });

  it('skips ReaderConfig with a dynamic topic variable', async () => {
    const batch = await extract('segmentio.go');
    const allUrls = [
      ...callers(batch).map((c) => c.urlLiteral),
      ...endpoints(batch).map((e) => e.routePattern),
    ];
    expect(allUrls).not.toContain('kafka:topic');
  });

  it('resolves aliased imports (segkafka, sar) to their canonical types', async () => {
    const batch = await extract('aliased.go');
    // newAliasedWriter: segkafka.WriterConfig → producer (1)
    // sendAliasedSaramaMessage: sar.ProducerMessage → producer (1)
    const cu = callers(batch).map((c) => c.urlLiteral);
    expect(cu).toContain('kafka:aliased-events');
    expect(cu).toContain('kafka:aliased-sarama-events');
    expect(callers(batch).length).toBe(2);
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('segmentio.go');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('attaches handlerFunctionId from the enclosing function', async () => {
    const batch = await extract('segmentio.go');
    for (const e of endpoints(batch)) {
      expect(e.handlerFunctionId).not.toBeNull();
    }
  });

  it('rejects all emits in a file with no kafka import', async () => {
    const batch = await extract('no_imports.go');
    expect(callers(batch)).toEqual([]);
    expect(endpoints(batch)).toEqual([]);
  });
});
