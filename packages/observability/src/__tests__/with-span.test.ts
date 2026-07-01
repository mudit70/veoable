import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { initObservability, resetObservability } from '../init.js';
import { activeSpan, withSpan } from '../with-span.js';

let exporter: InMemorySpanExporter;

beforeEach(async () => {
  await resetObservability();
  exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  initObservability({ provider });
});

afterEach(async () => {
  await resetObservability();
  exporter.reset();
});

describe('withSpan', () => {
  it('creates a span with the given name and attributes', async () => {
    await withSpan('extract.file', { 'file.path': 'src/app.ts' }, async () => {
      // work
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('extract.file');
    expect(spans[0].attributes['file.path']).toBe('src/app.ts');
  });

  it('returns the value fn returns', async () => {
    const result = await withSpan('compute', {}, async () => 42);
    expect(result).toBe(42);
  });

  it('ends the span on normal return', async () => {
    await withSpan('a', {}, async () => {});
    expect(exporter.getFinishedSpans()[0].ended).toBe(true);
  });

  it('nests spans under the active parent', async () => {
    await withSpan('outer', {}, async () => {
      await withSpan('inner', {}, async () => {});
    });
    const spans = exporter.getFinishedSpans();
    // Spans export in end-order; inner ends before outer.
    expect(spans.map((s) => s.name)).toEqual(['inner', 'outer']);
    const inner = spans.find((s) => s.name === 'inner')!;
    const outer = spans.find((s) => s.name === 'outer')!;
    // SDK 2.x exposes `parentSpanContext.spanId`; 1.x exposed `parentSpanId`.
    const parentSpanId =
      (inner as unknown as { parentSpanContext?: { spanId: string }; parentSpanId?: string })
        .parentSpanContext?.spanId ??
      (inner as unknown as { parentSpanId?: string }).parentSpanId;
    expect(parentSpanId).toBe(outer.spanContext().spanId);
  });

  it('records exceptions and sets ERROR status before re-throwing', async () => {
    const err = new Error('boom');
    await expect(withSpan('risky', {}, async () => { throw err; })).rejects.toBe(err);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR = 2
    expect(spans[0].status.message).toBe('boom');
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('ends the span even when fn throws', async () => {
    await expect(withSpan('risky', {}, async () => { throw new Error('x'); })).rejects.toThrow();
    expect(exporter.getFinishedSpans()[0].ended).toBe(true);
  });

  it('exposes the active span inside fn via activeSpan()', async () => {
    let inside: ReturnType<typeof activeSpan>;
    await withSpan('probe', {}, async () => {
      inside = activeSpan();
    });
    expect(inside).toBeDefined();
    expect(inside!.spanContext().spanId).not.toBe('0000000000000000');
  });
});

describe('withSpan synchronous fn', () => {
  it('accepts a non-async fn that returns a plain value', async () => {
    const result = await withSpan('sync', {}, () => 'hello');
    expect(result).toBe('hello');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('sync');
    expect(spans[0].ended).toBe(true);
  });

  it('records exceptions thrown synchronously and re-throws', async () => {
    const err = new Error('sync-boom');
    await expect(
      withSpan('sync-throw', {}, () => {
        throw err;
      })
    ).rejects.toBe(err);
    const spans = exporter.getFinishedSpans();
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].status.message).toBe('sync-boom');
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
  });
});

describe('withSpan attribute types', () => {
  it('accepts string, number, boolean, and array attribute values', async () => {
    await withSpan(
      'attr-types',
      {
        s: 'a',
        n: 42,
        b: true,
        sa: ['x', 'y'],
        na: [1, 2, 3],
      },
      async () => {}
    );
    const span = exporter.getFinishedSpans().find((s) => s.name === 'attr-types')!;
    expect(span.attributes.s).toBe('a');
    expect(span.attributes.n).toBe(42);
    expect(span.attributes.b).toBe(true);
    expect(span.attributes.sa).toEqual(['x', 'y']);
    expect(span.attributes.na).toEqual([1, 2, 3]);
  });
});

describe('activeSpan', () => {
  it('returns undefined outside any span', async () => {
    expect(activeSpan()).toBeUndefined();
  });
});
