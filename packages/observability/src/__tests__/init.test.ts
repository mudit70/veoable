import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { initObservability, resetObservability } from '../init.js';
import { withSpan } from '../with-span.js';

beforeEach(async () => {
  await resetObservability();
});

afterEach(async () => {
  await resetObservability();
  delete process.env.ADORABLE_OTEL_EXPORTER;
});

describe('initObservability idempotency', () => {
  it('is a no-op on the second call', async () => {
    initObservability({ exporter: 'none' });
    // Second call must not throw and must not replace the global provider.
    const before = trace.getTracerProvider();
    initObservability({ exporter: 'console' });
    const after = trace.getTracerProvider();
    expect(after).toBe(before);
  });

  it('starts fresh after resetObservability', async () => {
    initObservability({ exporter: 'none' });
    await resetObservability();
    // Should be re-initializable without throwing.
    expect(() => initObservability({ exporter: 'none' })).not.toThrow();
  });
});

describe('initObservability customExporter path', () => {
  it('installs a provider that routes spans to the custom exporter', async () => {
    const exporter = new InMemorySpanExporter();
    // Use the customExporter branch (not the provider branch).
    initObservability({ customExporter: exporter });
    await withSpan('via-custom-exporter', { k: 'v' }, async () => {});
    // Allow the SimpleSpanProcessor flush to complete.
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('via-custom-exporter');
    expect(spans[0].attributes.k).toBe('v');
  });
});

describe('initObservability env var path', () => {
  it('reads ADORABLE_OTEL_EXPORTER=console when no explicit exporter is provided', async () => {
    process.env.ADORABLE_OTEL_EXPORTER = 'console';
    // Silence console output from the ConsoleSpanExporter.
    const logSpy = vi.spyOn(console, 'dir').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    initObservability();
    // A real provider produces a span with a non-zero spanId.
    let observedSpanId: string | undefined;
    await withSpan('env-var-probe', {}, async (span) => {
      observedSpanId = span.spanContext().spanId;
    });
    expect(observedSpanId).toBeDefined();
    expect(observedSpanId).not.toBe('0000000000000000');
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('defaults to the no-op path when env var is unset', async () => {
    delete process.env.ADORABLE_OTEL_EXPORTER;
    initObservability();
    // No provider installed: spans created via the global tracer are no-op
    // (all-zero spanId).
    let observedSpanId: string | undefined;
    await withSpan('noop-probe', {}, async (span) => {
      observedSpanId = span.spanContext().spanId;
    });
    expect(observedSpanId).toBe('0000000000000000');
  });
});

describe('initObservability provider path', () => {
  it('uses an injected TracerProvider directly', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    initObservability({ provider });
    await withSpan('via-provider', {}, async () => {});
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain('via-provider');
  });
});
