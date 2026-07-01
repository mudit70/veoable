import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initObservability, recordConfidenceDecision, resetObservability, withSpan } from '../index.js';

/**
 * Performance canary. The #36 acceptance criterion says extraction must
 * add <50% overhead to per-file AST parse time *with telemetry installed
 * at the no-op level*. This test guards the no-op baseline: it asserts
 * that `withSpan` + `recordConfidenceDecision` in a tight loop with no
 * exporter stays under a very generous per-iteration budget. Budget is
 * intentionally loose so it does not flake on slow CI; the point is to
 * catch regressions where someone accidentally installs a provider by
 * default or adds synchronous IO to the hot path.
 */

const ITERATIONS = 10_000;
const MAX_NS_PER_ITER = 50_000; // 50 microseconds per `withSpan` call, generous

beforeEach(async () => {
  await resetObservability();
  initObservability({ exporter: 'none' });
});

afterEach(async () => {
  await resetObservability();
});

describe('no-op overhead', () => {
  it(`runs ${ITERATIONS} withSpan + recordConfidenceDecision in under ${MAX_NS_PER_ITER}ns/iter`, async () => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) {
      await withSpan('hot', { i }, async () => {
        recordConfidenceDecision('indirect callback');
      });
    }
    const elapsed = Number(process.hrtime.bigint() - start);
    const perIter = elapsed / ITERATIONS;
    // Report for debugging
    console.log(`no-op withSpan: ${perIter.toFixed(0)} ns/iter (${ITERATIONS} iterations)`);
    expect(perIter).toBeLessThan(MAX_NS_PER_ITER);
  });
});
