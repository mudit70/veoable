import { SpanStatusCode, context, trace, type Attributes, type Span } from '@opentelemetry/api';
import { getTracer } from './init.js';

/**
 * Run `fn` inside a new span. The span is created as a child of whatever
 * span is currently active in the OpenTelemetry context (so nested
 * `withSpan` calls form a tree), and is ended automatically on return or
 * throw. Exceptions are recorded on the span and the span status is set
 * to ERROR before the exception is re-thrown.
 *
 * If no tracer provider is installed (the default in production), the
 * global no-op tracer returns a no-op span and the overhead is a single
 * function call plus an object allocation that V8 elides in hot paths.
 */
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T> | T
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Return the currently active span, or `undefined` if none is active.
 * Used by `recordConfidenceDecision`.
 */
export function activeSpan(): Span | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const ctx = span.spanContext();
  // A no-op span has an all-zero spanId; treat it as "no active span"
  // so confidence decisions emitted outside a real trace are no-ops
  // instead of silently attaching to a no-op parent.
  if (ctx.spanId === '0000000000000000') return undefined;
  return span;
}
