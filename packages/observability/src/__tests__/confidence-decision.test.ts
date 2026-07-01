import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  __resetConfidenceDecisionWarning,
  initObservability,
  recordConfidenceDecision,
  resetObservability,
  withSpan,
} from '../index.js';

let exporter: InMemorySpanExporter;

beforeEach(async () => {
  await resetObservability();
  __resetConfidenceDecisionWarning();
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

describe('recordConfidenceDecision', () => {
  it('adds a ConfidenceDecision event to the active span with the reason', async () => {
    await withSpan('resolve.call', { 'call.site': 'foo()' }, async () => {
      recordConfidenceDecision('callback passed as parameter', { 'call.confidence': 'indirect' });
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const events = spans[0].events;
    const decision = events.find((e) => e.name === 'ConfidenceDecision');
    expect(decision).toBeDefined();
    expect(decision!.attributes?.reason).toBe('callback passed as parameter');
    expect(decision!.attributes?.['call.confidence']).toBe('indirect');
  });

  it('attaches the event to the innermost active span', async () => {
    await withSpan('outer', {}, async () => {
      await withSpan('inner', {}, async () => {
        recordConfidenceDecision('computed import');
      });
    });
    const spans = exporter.getFinishedSpans();
    const inner = spans.find((s) => s.name === 'inner')!;
    const outer = spans.find((s) => s.name === 'outer')!;
    expect(inner.events.some((e) => e.name === 'ConfidenceDecision')).toBe(true);
    expect(outer.events.some((e) => e.name === 'ConfidenceDecision')).toBe(false);
  });

  it('no-ops when no span is active', async () => {
    // No provider / no active span — should not throw.
    recordConfidenceDecision('no span here');
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('silently no-ops when called outside a span — no stderr noise', async () => {
    // Previously this helper warned in dev mode when called outside
    // an active span, intending to catch "plugin called
    // recordConfidenceDecision outside a withSpan" bugs. In practice
    // the warning fired constantly in unit tests that didn't install
    // an in-memory tracer, producing noise without catching real
    // bugs — tracer-verified tests already catch missing events via
    // explicit assertions. The warning was removed; this test pins
    // the new silent behavior so a future reviver of the warning has
    // to deliberately update it.
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      __resetConfidenceDecisionWarning();
      recordConfidenceDecision('first');
      recordConfidenceDecision('second');
      expect(warnings).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});
