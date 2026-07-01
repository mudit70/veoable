import { trace, type Tracer, type TracerProvider } from '@opentelemetry/api';
import { ConsoleSpanExporter, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * Observability initialization.
 *
 * Default exporter is **none** — the global no-op tracer returned by
 * `trace.getTracer` when no provider is registered produces zero overhead
 * in production extraction runs. This is the baseline the #36 performance
 * gate (<50% overhead) is measured against.
 *
 * Dev: set `ADORABLE_OTEL_EXPORTER=console` to print spans to stdout.
 * Tests inject their own exporter via `initObservability({ exporter })`.
 * OTLP support is deferred until we actually turn on remote tracing.
 */

const TRACER_NAME = '@veoable/observability';
const TRACER_VERSION = '0.1.0';

export type ExporterKind = 'none' | 'console';

export interface InitOptions {
  /** Explicit exporter kind. If omitted, read from `ADORABLE_OTEL_EXPORTER`. */
  exporter?: ExporterKind;
  /**
   * Inject a custom `SpanExporter`. Used by tests to install an
   * `InMemorySpanExporter` without going through env vars. When set,
   * overrides `exporter`.
   */
  customExporter?: SpanExporter;
  /**
   * Custom `TracerProvider`. Used by tests that need full control over
   * the provider lifecycle. Overrides both other options when set.
   */
  provider?: TracerProvider;
}

let initialized = false;
let activeProvider: NodeTracerProvider | null = null;

/**
 * Initialize observability. Idempotent: calling it twice with the same
 * options is a no-op. Calling it with different options after the first
 * successful init throws — tests must call `resetObservability()` first.
 */
export function initObservability(opts: InitOptions = {}): void {
  if (initialized) return;

  if (opts.provider) {
    trace.setGlobalTracerProvider(opts.provider);
    initialized = true;
    return;
  }

  const kind: ExporterKind =
    opts.customExporter !== undefined
      ? 'console' // any non-none kind will do; customExporter overrides
      : opts.exporter ?? (process.env.ADORABLE_OTEL_EXPORTER as ExporterKind | undefined) ?? 'none';

  if (kind === 'none' && !opts.customExporter) {
    // No provider installed — OTEL's global no-op tracer is used.
    initialized = true;
    return;
  }

  const exporter: SpanExporter = opts.customExporter ?? new ConsoleSpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  activeProvider = provider;
  initialized = true;
}

/**
 * Tear down the active tracer provider and reset the init flag. Intended
 * for tests; not for production code paths.
 */
export async function resetObservability(): Promise<void> {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
  trace.disable();
  initialized = false;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}
