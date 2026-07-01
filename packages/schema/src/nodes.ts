import { z } from 'zod';

/**
 * Canonical node schemas for the Adorable knowledge graph.
 *
 * Every plugin emits nodes that conform to one of these schemas. New
 * cross-cutting concepts are added here, never invented inside a plugin.
 *
 * TS types are derived via `z.infer` so there is exactly one source of
 * truth per node type.
 */

// ──────────────────────────────────────────────────────────────────────
// Source evidence (owned by #96)
// ──────────────────────────────────────────────────────────────────────

export const SourceEvidenceSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  snippet: z.string(),
  confidence: z.enum(['exact', 'heuristic', 'inferred']),
}).refine((data) => data.lineEnd >= data.lineStart, {
  message: 'lineEnd must be >= lineStart',
});
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;

// ──────────────────────────────────────────────────────────────────────
// Code structure (foundational, owned by #36)
// ──────────────────────────────────────────────────────────────────────

export const SourceFileSchema = z.object({
  nodeType: z.literal('SourceFile'),
  id: z.string(),
  filePath: z.string(),
  repository: z.string(),
  language: z.string(),
  framework: z.string().nullable(),
});
export type SourceFile = z.infer<typeof SourceFileSchema>;

export const ParameterSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
});
export type Parameter = z.infer<typeof ParameterSchema>;

export const ResponseShapeSchema = z.object({
  statusCode: z.number().int().nullable(),
  bodyExpression: z.string().nullable(),
  isErrorPath: z.boolean(),
  sourceLine: z.number().int().nonnegative(),
});
export type ResponseShape = z.infer<typeof ResponseShapeSchema>;

export const RequestFieldSchema = z.object({
  name: z.string(),
  source: z.enum(['body', 'params', 'query', 'headers']),
  type: z.string().nullable(),
});
export type RequestField = z.infer<typeof RequestFieldSchema>;

export const FunctionDefinitionSchema = z.object({
  nodeType: z.literal('FunctionDefinition'),
  id: z.string(),
  name: z.string(),
  sourceFileId: z.string(),
  sourceLine: z.number().int().nonnegative(),
  parameters: z.array(ParameterSchema),
  returnType: z.string().nullable(),
  isExported: z.boolean(),
  isAsync: z.boolean(),
  evidence: SourceEvidenceSchema.optional(),
  responses: z.array(ResponseShapeSchema).optional(),
  /** Request fields accessed in this function (req.body.X, req.params.Y, etc.). */
  requestFields: z.array(RequestFieldSchema).optional(),
});
export type FunctionDefinition = z.infer<typeof FunctionDefinitionSchema>;

// ──────────────────────────────────────────────────────────────────────
// HTTP surface (consumed by #15–#31, #56–#62, stitched by #4)
// ──────────────────────────────────────────────────────────────────────

export const MiddlewareEntrySchema = z.object({
  functionId: z.string().nullable(),
  name: z.string(),
  order: z.number().int().nonnegative(),
});
export type MiddlewareEntry = z.infer<typeof MiddlewareEntrySchema>;

export const APIEndpointSchema = z.object({
  nodeType: z.literal('APIEndpoint'),
  id: z.string(),
  httpMethod: z.string(),
  routePattern: z.string(),
  handlerFunctionId: z.string().nullable(),
  framework: z.string(),
  repository: z.string(),
  evidence: SourceEvidenceSchema.optional(),
  /** Ordered middleware chain that runs before the handler (#140). */
  middlewareChain: z.array(MiddlewareEntrySchema).optional(),
  /**
   * #110 — Declarative response schemas attached at the route
   * definition (Fastify `{ schema: { response: { 200: {...} } } }`,
   * OpenAPI route specs, tRPC procedure return types). These COMPLEMENT
   * the AST-observed responses on the handler `FunctionDefinition` —
   * the FunctionDefinition's `responses` track what the handler
   * actually does (`res.json(x)` / `reply.send(y)`), while this field
   * tracks what the framework was TOLD the response shape should be.
   * For schema-driven frameworks like Fastify the declarative shape is
   * often the richer signal (status codes + body type), so consumers
   * should prefer it when both are present.
   */
  responses: z.array(ResponseShapeSchema).optional(),
});
export type APIEndpoint = z.infer<typeof APIEndpointSchema>;

export const HttpEgressConfidenceSchema = z.enum(['exact', 'pattern', 'dynamic']);
export type HttpEgressConfidence = z.infer<typeof HttpEgressConfidenceSchema>;

export const ResponseHandlerSchema = z.object({
  kind: z.enum(['json-parse', 'state-update', 'error-handler', 'other']),
  expression: z.string(),
  targetStateVar: z.string().nullable(),
  sourceLine: z.number().int().nonnegative(),
});
export type ResponseHandler = z.infer<typeof ResponseHandlerSchema>;

export const ClientSideAPICallerSchema = z.object({
  nodeType: z.literal('ClientSideAPICaller'),
  id: z.string(),
  functionId: z.string(),
  sourceFileId: z.string(),
  sourceLine: z.number().int().nonnegative(),
  httpMethod: z.string().nullable(),
  urlLiteral: z.string().nullable(),
  egressConfidence: HttpEgressConfidenceSchema,
  templateSpanCount: z.number().int().nonnegative().nullable().optional(),
  templateSegmentCount: z.number().int().nonnegative().nullable().optional(),
  /** All literal parts of a template URL, including suffixes between/after spans.
   *  e.g., `/projects/${id}/diagrams` → ['/projects/', '/diagrams'] */
  templateParts: z.array(z.string()).optional(),
  framework: z.string(),
  repository: z.string(),
  /** True when the URL targets an external service (has an absolute host with a public domain). */
  isExternal: z.boolean().optional(),
  /** Extracted hostname for external calls (e.g., "api.openai.com"). Null for internal calls. */
  externalHost: z.string().nullable().optional(),
  evidence: SourceEvidenceSchema.optional(),
  responseHandlers: z.array(ResponseHandlerSchema).optional(),
});
export type ClientSideAPICaller = z.infer<typeof ClientSideAPICallerSchema>;

export const ProcessKindSchema = z.enum([
  'ui_action',
  'event_handler',
  'lifecycle_hook',
  'state_observer',
  'timer',
  'browser_event',
  'cli_command',
  'script_entry',
  'bridge_command',
  'other',
]);
export type ProcessKind = z.infer<typeof ProcessKindSchema>;

export const ClientSideProcessSchema = z.object({
  nodeType: z.literal('ClientSideProcess'),
  id: z.string(),
  kind: ProcessKindSchema,
  name: z.string(),
  functionId: z.string(),
  sourceFileId: z.string(),
  sourceLine: z.number().int().nonnegative(),
  framework: z.string(),
  repository: z.string(),
  evidence: SourceEvidenceSchema.optional(),
});
export type ClientSideProcess = z.infer<typeof ClientSideProcessSchema>;

// ──────────────────────────────────────────────────────────────────────
// Database (foundational, owned by #64)
// ──────────────────────────────────────────────────────────────────────

export const DatabaseKindSchema = z.enum([
  'postgres',
  'mysql',
  'sqlite',
  'mssql',
  'oracle',
  'mongodb',
  'redis',
  'memcached',
  'dynamodb',
  'cassandra',
  'elasticsearch',
  'other',
]);
export type DatabaseKind = z.infer<typeof DatabaseKindSchema>;

export const DatabaseSystemSchema = z.object({
  nodeType: z.literal('DatabaseSystem'),
  id: z.string(),
  kind: DatabaseKindSchema,
  name: z.string(),
  connectionSource: z.string().nullable(),
});
export type DatabaseSystem = z.infer<typeof DatabaseSystemSchema>;

export const DatabaseTableKindSchema = z.enum(['table', 'view', 'collection']);
export type DatabaseTableKind = z.infer<typeof DatabaseTableKindSchema>;

export const DatabaseTableSchema = z.object({
  nodeType: z.literal('DatabaseTable'),
  id: z.string(),
  systemId: z.string(),
  name: z.string(),
  schema: z.string().nullable(),
  kind: DatabaseTableKindSchema,
  declaredIn: z.string().nullable(),
});
export type DatabaseTable = z.infer<typeof DatabaseTableSchema>;

export const DatabaseColumnSchema = z.object({
  nodeType: z.literal('DatabaseColumn'),
  id: z.string(),
  tableId: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  nullable: z.boolean().nullable(),
  isPrimaryKey: z.boolean(),
  isForeignKey: z.boolean(),
});
export type DatabaseColumn = z.infer<typeof DatabaseColumnSchema>;

export const DatabaseOperationSchema = z.enum(['read', 'write', 'update', 'delete', 'upsert', 'raw']);
export type DatabaseOperation = z.infer<typeof DatabaseOperationSchema>;

export const DatabaseInteractionConfidenceSchema = z.enum(['direct', 'inferred', 'dynamic']);
export type DatabaseInteractionConfidence = z.infer<typeof DatabaseInteractionConfidenceSchema>;

export const DatabaseInteractionSchema = z.object({
  nodeType: z.literal('DatabaseInteraction'),
  id: z.string(),
  callSiteFunctionId: z.string(),
  operation: DatabaseOperationSchema,
  orm: z.string(),
  rawQuery: z.string().nullable(),
  confidence: DatabaseInteractionConfidenceSchema,
  evidence: SourceEvidenceSchema.optional(),
});
export type DatabaseInteraction = z.infer<typeof DatabaseInteractionSchema>;

// ──────────────────────────────────────────────────────────────────────
// Navigation (React Native / Expo Router, owned by #167)
// ──────────────────────────────────────────────────────────────────────

/** Mobile navigator kinds (React Native): stack, tab, drawer, modal,
 *  expo-router. Web variant: 'web-router' for any react-router-dom /
 *  Next.js / Remix / SvelteKit / SSG router. 'other' is the catch-all.
 *
 *  Optional on Screen — SSG/SSR pages have no navigator concept; they
 *  just have a route path. (#198 PR1, #187 schema bits.) */
export const NavigatorKindSchema = z.enum([
  'stack', 'tab', 'drawer', 'modal', 'expo-router', 'web-router', 'other',
]);
export type NavigatorKind = z.infer<typeof NavigatorKindSchema>;

export const ScreenSchema = z.object({
  nodeType: z.literal('Screen'),
  id: z.string(),
  /** Screen name as declared in the navigator (e.g., "UserDetail").
   *  For web routes without a stable component name (or where the
   *  component is anonymous), producers should pass the routePath as
   *  the name to keep `name` non-empty. */
  name: z.string(),
  /** FunctionDefinition id of the component rendered by this screen. */
  componentFunctionId: z.string().nullable(),
  /** Kind of navigator this screen belongs to. Optional because
   *  SSG/SSR pages have no navigator concept (#198 PR1). RN producers
   *  always set it; web producers usually set 'web-router'. */
  navigatorKind: NavigatorKindSchema.optional(),
  /** Route path for web/SSG screens, e.g. `/projects/:id/flows`,
   *  `/users/:id`, or `/blog/post-title/`. `null` for RN screens
   *  (where identity is the navigator name, not a URL). */
  routePath: z.string().nullable().optional(),
  /** Screen id of the parent route in nested-router setups (e.g.
   *  react-router `<Route>` children, Remix nested layouts).
   *  `null` / absent for top-level screens. */
  parentScreenId: z.string().nullable().optional(),
  sourceFileId: z.string(),
  sourceLine: z.number().int().nonnegative(),
  framework: z.string(),
  repository: z.string(),
  evidence: SourceEvidenceSchema.optional(),
});
export type Screen = z.infer<typeof ScreenSchema>;

// ──────────────────────────────────────────────────────────────────────
// Environment variables (#139 gap 3)
// ──────────────────────────────────────────────────────────────────────

export const EnvVarCategorySchema = z.enum([
  'database', 'auth', 'api', 'config', 'unknown',
]);
export type EnvVarCategory = z.infer<typeof EnvVarCategorySchema>;

export const EnvironmentVariableSchema = z.object({
  nodeType: z.literal('EnvironmentVariable'),
  id: z.string(),
  /** Variable name (e.g., "DATABASE_URL", "JWT_SECRET"). */
  name: z.string(),
  /** Auto-categorized by naming convention. */
  category: EnvVarCategorySchema,
  /** Whether a default/fallback value is provided. */
  hasDefault: z.boolean(),
  /** Access style: process.env, import.meta.env, os.environ, etc. */
  accessPattern: z.string(),
  sourceFileId: z.string(),
  sourceLine: z.number().int().nonnegative(),
  /** FunctionDefinition id if accessed inside a function (null for module-level). */
  functionId: z.string().nullable(),
  repository: z.string(),
});
export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;

// ──────────────────────────────────────────────────────────────────────
// Client-side state stores (#192 — Zustand / Redux / Pinia / MobX)
// ──────────────────────────────────────────────────────────────────────

/**
 * Client-side state container — Zustand store, Pinia store, MobX
 * store, etc. Mirrors `DatabaseTable` for the SPA-state world: the
 * fields are the slices a component reads, the actions are the
 * functions a component calls to mutate. READS_STATE / WRITES_STATE
 * edges connect them to FunctionDefinitions.
 *
 * Pure-additive in 0.3.0 — no SCHEMA_VERSION rotation.
 */
export const StateStoreFieldSchema = z.object({
  name: z.string(),
  /** Optional declared type, e.g., "User | null". Free-form text. */
  type: z.string().nullable(),
});
export type StateStoreField = z.infer<typeof StateStoreFieldSchema>;

export const StateStoreSchema = z.object({
  nodeType: z.literal('StateStore'),
  id: z.string(),
  /** Store name as declared (e.g., "useStore", "useUserStore"). */
  name: z.string(),
  /** Producer framework: 'zustand', 'redux', 'pinia', 'mobx'. */
  framework: z.string(),
  /** SourceFile id where the store is declared. */
  declaredIn: z.string(),
  /** Top-level non-function keys of the store object. */
  fields: z.array(StateStoreFieldSchema),
  /** Top-level function keys (setters / actions / thunks). */
  actions: z.array(z.string()),
  sourceLine: z.number().int().nonnegative(),
  repository: z.string(),
});
export type StateStore = z.infer<typeof StateStoreSchema>;

// ──────────────────────────────────────────────────────────────────────
// Discriminated union of all node types
// ──────────────────────────────────────────────────────────────────────

export const SchemaNodeSchema = z.discriminatedUnion('nodeType', [
  SourceFileSchema,
  FunctionDefinitionSchema,
  APIEndpointSchema,
  ClientSideAPICallerSchema,
  ClientSideProcessSchema,
  DatabaseSystemSchema,
  DatabaseTableSchema,
  DatabaseColumnSchema,
  DatabaseInteractionSchema,
  ScreenSchema,
  EnvironmentVariableSchema,
  StateStoreSchema,
]);
export type SchemaNode = z.infer<typeof SchemaNodeSchema>;

export type NodeType = SchemaNode['nodeType'];
