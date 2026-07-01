import { z } from 'zod';

/**
 * Canonical edge schemas for the Adorable knowledge graph.
 *
 * Edges connect nodes by ID. The schema package does not enforce the
 * (from-type, to-type) pairing at the type level — that is the graph
 * store's job at commit time — but the docstrings here document the
 * intended endpoints so plugin authors don't need to dig through #36/#64.
 */

// ──────────────────────────────────────────────────────────────────────
// Code-structure edges (#36)
// ──────────────────────────────────────────────────────────────────────

/** SourceFile → SourceFile */
export const ImportsEdgeSchema = z.object({
  edgeType: z.literal('IMPORTS'),
  from: z.string(),
  to: z.string(),
  symbols: z.array(z.string()),
  isDefault: z.boolean(),
  isDynamic: z.boolean(),
});
export type ImportsEdge = z.infer<typeof ImportsEdgeSchema>;

/** SourceFile → FunctionDefinition */
export const ExportsEdgeSchema = z.object({
  edgeType: z.literal('EXPORTS'),
  from: z.string(),
  to: z.string(),
  exportName: z.string(),
  isDefault: z.boolean(),
});
export type ExportsEdge = z.infer<typeof ExportsEdgeSchema>;

/** FunctionDefinition → SourceFile */
export const DefinedInEdgeSchema = z.object({
  edgeType: z.literal('DEFINED_IN'),
  from: z.string(),
  to: z.string(),
});
export type DefinedInEdge = z.infer<typeof DefinedInEdgeSchema>;

/**
 * Call confidence per #36:
 * - `direct`   — statically resolvable free function call
 * - `method`   — method call where receiver type is known
 * - `indirect` — callback passed as parameter / higher-order
 * - `dynamic`  — computed function name or dynamic import
 */
export const CallConfidenceSchema = z.enum(['direct', 'method', 'indirect', 'dynamic']);
export type CallConfidence = z.infer<typeof CallConfidenceSchema>;

/** FunctionDefinition → FunctionDefinition */
export const CallsFunctionEdgeSchema = z.object({
  edgeType: z.literal('CALLS_FUNCTION'),
  from: z.string(),
  to: z.string(),
  sourceLine: z.number().int().nonnegative(),
  arguments: z.array(z.string()),
  isConditional: z.boolean(),
  confidence: CallConfidenceSchema,
});
export type CallsFunctionEdge = z.infer<typeof CallsFunctionEdgeSchema>;

// ──────────────────────────────────────────────────────────────────────
// Client-side flow edges (#98)
// ──────────────────────────────────────────────────────────────────────

/** ClientSideProcess → FunctionDefinition */
export const TriggersEdgeSchema = z.object({
  edgeType: z.literal('TRIGGERS'),
  from: z.string(),
  to: z.string(),
});
export type TriggersEdge = z.infer<typeof TriggersEdgeSchema>;

/** FunctionDefinition → ClientSideAPICaller */
export const MakesRequestEdgeSchema = z.object({
  edgeType: z.literal('MAKES_REQUEST'),
  from: z.string(),
  to: z.string(),
});
export type MakesRequestEdge = z.infer<typeof MakesRequestEdgeSchema>;

// ──────────────────────────────────────────────────────────────────────
// Stitcher edge (#4) — produced by the flow stitcher, not extractors
// ──────────────────────────────────────────────────────────────────────

export const ResolvesMatchedBySchema = z.enum(['exact-url', 'pattern', 'inferred']);
export type ResolvesMatchedBy = z.infer<typeof ResolvesMatchedBySchema>;

export const MatchConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type MatchConfidence = z.infer<typeof MatchConfidenceSchema>;

export const StitchConfirmedBySchema = z.enum(['human', 'ai', 'auto']);
export type StitchConfirmedBy = z.infer<typeof StitchConfirmedBySchema>;

/** ClientSideAPICaller → APIEndpoint */
export const ResolvesToEndpointEdgeSchema = z.object({
  edgeType: z.literal('RESOLVES_TO_ENDPOINT'),
  from: z.string(),
  to: z.string(),
  matchedBy: ResolvesMatchedBySchema,
  matchConfidence: MatchConfidenceSchema,
  /** Who confirmed this stitch. Present only for confirmed edges. */
  confirmedBy: StitchConfirmedBySchema.optional(),
  /** ISO timestamp of confirmation. */
  confirmedAt: z.string().optional(),
  /** Which stitching strategy produced the match. */
  strategy: z.string().optional(),
  /** Human/AI explanation for the match. */
  reason: z.string().optional(),
  /** Repository the caller belongs to. */
  fromRepository: z.string().optional(),
  /** Repository the endpoint belongs to. */
  toRepository: z.string().optional(),
});
export type ResolvesToEndpointEdge = z.infer<typeof ResolvesToEndpointEdgeSchema>;

// ──────────────────────────────────────────────────────────────────────
// Database edges (#64)
// ──────────────────────────────────────────────────────────────────────

/** DatabaseTable → DatabaseSystem */
export const TableInEdgeSchema = z.object({
  edgeType: z.literal('TABLE_IN'),
  from: z.string(),
  to: z.string(),
});
export type TableInEdge = z.infer<typeof TableInEdgeSchema>;

/** DatabaseColumn → DatabaseTable */
export const ColumnInEdgeSchema = z.object({
  edgeType: z.literal('COLUMN_IN'),
  from: z.string(),
  to: z.string(),
});
export type ColumnInEdge = z.infer<typeof ColumnInEdgeSchema>;

/** DatabaseColumn → DatabaseColumn */
export const ForeignKeyEdgeSchema = z.object({
  edgeType: z.literal('FOREIGN_KEY'),
  from: z.string(),
  to: z.string(),
  onDelete: z.string().nullable(),
  onUpdate: z.string().nullable(),
});
export type ForeignKeyEdge = z.infer<typeof ForeignKeyEdgeSchema>;

/** DatabaseInteraction → DatabaseTable */
export const ReadsEdgeSchema = z.object({
  edgeType: z.literal('READS'),
  from: z.string(),
  to: z.string(),
  columns: z.array(z.string()).nullable(),
  filters: z.string().nullable(),
});
export type ReadsEdge = z.infer<typeof ReadsEdgeSchema>;

export const WritesKindSchema = z.enum(['insert', 'update', 'upsert', 'delete']);
export type WritesKind = z.infer<typeof WritesKindSchema>;

/** DatabaseInteraction → DatabaseTable */
export const WritesEdgeSchema = z.object({
  edgeType: z.literal('WRITES'),
  from: z.string(),
  to: z.string(),
  columns: z.array(z.string()).nullable(),
  kind: WritesKindSchema,
});
export type WritesEdge = z.infer<typeof WritesEdgeSchema>;

/** DatabaseInteraction → FunctionDefinition */
export const PerformedByEdgeSchema = z.object({
  edgeType: z.literal('PERFORMED_BY'),
  from: z.string(),
  to: z.string(),
  sourceLine: z.number().int().nonnegative(),
});
export type PerformedByEdge = z.infer<typeof PerformedByEdgeSchema>;

// ──────────────────────────────────────────────────────────────────────
// Navigation edges (#167 — React Native / Expo Router)
// ──────────────────────────────────────────────────────────────────────

/** FunctionDefinition → Screen (navigation.navigate call) */
export const NavigatesToEdgeSchema = z.object({
  edgeType: z.literal('NAVIGATES_TO'),
  from: z.string(),
  to: z.string(),
  /** The navigation method: navigate, push, replace, goBack, etc. */
  method: z.string().optional(),
  sourceLine: z.number().int().nonnegative().optional(),
});
export type NavigatesToEdge = z.infer<typeof NavigatesToEdgeSchema>;

/** Screen → FunctionDefinition (component rendered by this screen) */
export const ScreenComponentEdgeSchema = z.object({
  edgeType: z.literal('SCREEN_COMPONENT'),
  from: z.string(),
  to: z.string(),
});
export type ScreenComponentEdge = z.infer<typeof ScreenComponentEdgeSchema>;

/**
 * FunctionDefinition → StateStore (#192 — read of a state slice).
 *
 * Emitted when a function reads from a Zustand-style store via a
 * selector or `getState()` call. The optional `field` is the
 * top-level key being read (e.g., 'user' for `useStore(s => s.user)`).
 * When the read is broad (`useStore.getState()` with no further
 * property access), `field` is null.
 */
export const ReadsStateEdgeSchema = z.object({
  edgeType: z.literal('READS_STATE'),
  from: z.string(),
  to: z.string(),
  field: z.string().nullable().optional(),
  sourceLine: z.number().int().nonnegative().optional(),
});
export type ReadsStateEdge = z.infer<typeof ReadsStateEdgeSchema>;

/**
 * FunctionDefinition → StateStore (#192 — write of a state slice).
 *
 * Emitted when a function calls a setter / action on the store
 * (e.g., `useStore.getState().setUser(x)` or `set({ foo: x })`
 * inside the store definition itself). The optional `action` is the
 * setter / action name being invoked.
 */
export const WritesStateEdgeSchema = z.object({
  edgeType: z.literal('WRITES_STATE'),
  from: z.string(),
  to: z.string(),
  action: z.string().nullable().optional(),
  sourceLine: z.number().int().nonnegative().optional(),
});
export type WritesStateEdge = z.infer<typeof WritesStateEdgeSchema>;

/**
 * APIEndpoint → Screen (#198 PR3b — server-side rendering edges).
 *
 * Emitted when a server-side handler ends in a template-render call,
 * e.g.:
 *   app.get('/login', (req, res) => res.render('auth/signin'));
 *   app.post('/foo', async (req, res) => res.render('foo.njk', { data }));
 *
 * Pure-additive — no SCHEMA_VERSION rotation. Cross-correlates the
 * APIEndpoint's URL flow with the SSG/SSR Screen producer
 * (#198 PR3a, #226), giving a single graph hop from incoming HTTP
 * request to the rendered template.
 */
export const RendersEdgeSchema = z.object({
  edgeType: z.literal('RENDERS'),
  from: z.string(),
  to: z.string(),
  /** Template name as passed to the render call (e.g. 'auth/signin'
   *  or 'foo.njk'). Stored for traceability + future stitch rules. */
  templateName: z.string().optional(),
  /** Source line of the `res.render(...)` (or equivalent) call. */
  sourceLine: z.number().int().nonnegative().optional(),
});
export type RendersEdge = z.infer<typeof RendersEdgeSchema>;

/**
 * SourceFile (bundle output) → SourceFile (entry source) — #197.
 *
 * Emitted by `framework-bundler` when a webpack/vite/rollup/esbuild
 * config maps a bundle output filename to its entry TS source. With
 * this edge in place, lang-html's `<script src="/assets/app.js">`
 * resolution can hop through the bundle SourceFile to the actual
 * entry source.
 *
 * Pure-additive — no SCHEMA_VERSION rotation.
 */
export const BundlesToEdgeSchema = z.object({
  edgeType: z.literal('BUNDLES_TO'),
  /** SourceFile id of the bundle output (synthetic — the filename pattern's resolved value). */
  from: z.string(),
  /** SourceFile id of the entry TS source. */
  to: z.string(),
  /** Bundler tool: 'webpack' | 'vite' | 'rollup' | 'esbuild'. */
  bundler: z.string(),
  /** Logical entry name (e.g., 'main', 'auth_signin'). */
  entryName: z.string().optional(),
  /** Path of the bundler config file relative to project root. */
  configPath: z.string().optional(),
});
export type BundlesToEdge = z.infer<typeof BundlesToEdgeSchema>;

// ──────────────────────────────────────────────────────────────────────
// Discriminated union of all edge types
// ──────────────────────────────────────────────────────────────────────

export const SchemaEdgeSchema = z.discriminatedUnion('edgeType', [
  ImportsEdgeSchema,
  ExportsEdgeSchema,
  DefinedInEdgeSchema,
  CallsFunctionEdgeSchema,
  TriggersEdgeSchema,
  MakesRequestEdgeSchema,
  ResolvesToEndpointEdgeSchema,
  TableInEdgeSchema,
  ColumnInEdgeSchema,
  ForeignKeyEdgeSchema,
  ReadsEdgeSchema,
  WritesEdgeSchema,
  PerformedByEdgeSchema,
  NavigatesToEdgeSchema,
  ScreenComponentEdgeSchema,
  RendersEdgeSchema,
  ReadsStateEdgeSchema,
  WritesStateEdgeSchema,
  BundlesToEdgeSchema,
]);
export type SchemaEdge = z.infer<typeof SchemaEdgeSchema>;

export type EdgeType = SchemaEdge['edgeType'];

/**
 * #290 — canonical list of every edge-type literal accepted by the
 * schema. Single source of truth for MCP-server / REST-server enum
 * declarations so they don't drift out of sync as new edge types are
 * added.
 *
 * Adding a new edge type requires:
 *   1. New `<Name>EdgeSchema` with `edgeType: z.literal('<NAME>')`
 *   2. Add the schema to `SchemaEdgeSchema`'s discriminatedUnion
 *   3. Add the literal name to this array
 */
export const EDGE_TYPES = [
  'IMPORTS',
  'EXPORTS',
  'DEFINED_IN',
  'CALLS_FUNCTION',
  'TRIGGERS',
  'MAKES_REQUEST',
  'RESOLVES_TO_ENDPOINT',
  'TABLE_IN',
  'COLUMN_IN',
  'FOREIGN_KEY',
  'READS',
  'WRITES',
  'PERFORMED_BY',
  'NAVIGATES_TO',
  'SCREEN_COMPONENT',
  'RENDERS',
  'READS_STATE',
  'WRITES_STATE',
  'BUNDLES_TO',
] as const satisfies readonly EdgeType[];

/**
 * Compile-time exhaustiveness check (#290). The `satisfies` above only
 * catches typos / invalid entries in EDGE_TYPES — it does NOT catch
 * the case where a new edge schema is added to the discriminated union
 * but forgotten in EDGE_TYPES. This Exclude<> tail-check enforces the
 * reverse direction: if any EdgeType literal isn't in EDGE_TYPES, the
 * `_edgeTypesExhaustive` line fails to compile.
 *
 * To resolve a build break here: add the missing edge-type string
 * literal to EDGE_TYPES above.
 */
type _MissingEdgeTypes = Exclude<EdgeType, typeof EDGE_TYPES[number]>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _edgeTypesExhaustive: [_MissingEdgeTypes] extends [never] ? true : false = true;
