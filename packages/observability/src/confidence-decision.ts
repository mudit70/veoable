import type { Attributes } from '@opentelemetry/api';
import { activeSpan } from './with-span.js';

/**
 * Record a confidence-decision span event on the currently active span.
 *
 * **Hard rule:** every plugin that emits an edge with `confidence:
 * 'dynamic'` or `'inferred'` MUST call this helper with a human-readable
 * reason explaining *why* the decision was made. This is the mechanism
 * that makes real-world extraction failures debuggable — grep for
 * `ConfidenceDecision` span events in the trace of a failing fixture and
 * you see exactly which resolution strategy bailed out and why.
 *
 * Behavior:
 *
 *   - **Active span present** (tracer provider installed and a
 *     `withSpan` block is active): add a `ConfidenceDecision` event
 *     to the span with the supplied reason and attributes.
 *   - **No active span**: silently no-op. This covers both the
 *     "no tracer provider installed" case (the default — user opted
 *     out of observability) and the "provider installed but code
 *     runs outside a `withSpan` block" case.
 *
 * The helper deliberately does NOT warn on the no-span path. The
 * detection-role a warning would play is better handled by
 * tracer-verified tests that install an `InMemorySpanExporter` and
 * assert the expected `ConfidenceDecision` events fire — a missing
 * event is caught by a failing assertion, not by noisy stderr.
 */
const EVENT_NAME = 'ConfidenceDecision';

export function recordConfidenceDecision(reason: string, attrs: Attributes = {}): void {
  const span = activeSpan();
  if (!span) return;
  span.addEvent(EVENT_NAME, { reason, ...attrs });
}

/**
 * Back-compat no-op. The warning flag was removed when the no-span
 * warning itself was removed (see the JSDoc on
 * `recordConfidenceDecision`). Kept as an export so tests that call
 * it in `beforeEach` don't break.
 */
export function __resetConfidenceDecisionWarning(): void {
  // intentionally empty
}
