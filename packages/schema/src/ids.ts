import { createHash } from 'node:crypto';

/**
 * Canonical ID scheme for all knowledge graph nodes.
 *
 * Format: `{type}:{sha1(canonical-identifying-fields)[:16]}`
 *
 * IDs are content-addressed and stable: emitting the same logical node from
 * two different plugins yields the same ID, so writes are idempotent. SHA-1
 * is used as a fast non-cryptographic stable hash; 16 hex characters is
 * collision-safe at our scale.
 *
 * The schema package is the *only* place that knows the identifying-field
 * recipe per node type. Plugins MUST go through these helpers and never
 * hand-roll IDs.
 */

const ID_HASH_LENGTH = 16;

function hash(parts: ReadonlyArray<string | number | null | undefined>): string {
  const canonical = parts.map((p) => (p === null || p === undefined ? '\u0000' : String(p))).join('\u0001');
  return createHash('sha1').update(canonical).digest('hex').slice(0, ID_HASH_LENGTH);
}

function makeId(type: string, parts: ReadonlyArray<string | number | null | undefined>): string {
  return `${type}:${hash(parts)}`;
}

export const idFor = {
  sourceFile(input: { repository: string; filePath: string }): string {
    return makeId('SourceFile', [input.repository, input.filePath]);
  },

  functionDefinition(input: { sourceFileId: string; name: string; sourceLine: number }): string {
    return makeId('FunctionDefinition', [input.sourceFileId, input.name, input.sourceLine]);
  },

  /**
   * APIEndpoint id (#185).
   *
   * `filePath` and `lineStart` are part of the identity so two routes
   * that share `(repository, httpMethod, routePattern)` in DIFFERENT
   * source files don't collide. Pre-#185, two Fastify plugin files
   * each registering `fastify.get('/:id', ...)` produced identical
   * IDs and the second emit overwrote the first (last-write-wins in
   * the canonical store), silently dropping the route from analysis.
   *
   * Both fields are now required. Every visitor already builds the
   * evidence object with these values just before emitting; the
   * change is mechanical at the call sites.
   */
  apiEndpoint(input: {
    repository: string;
    httpMethod: string;
    routePattern: string;
    filePath: string;
    lineStart: number;
  }): string {
    return makeId('APIEndpoint', [
      input.repository,
      input.httpMethod.toUpperCase(),
      input.routePattern,
      input.filePath,
      input.lineStart,
    ]);
  },

  clientSideAPICaller(input: {
    sourceFileId: string;
    sourceLine: number;
    urlLiteral: string | null;
  }): string {
    return makeId('ClientSideAPICaller', [input.sourceFileId, input.sourceLine, input.urlLiteral ?? 'dynamic']);
  },

  clientSideProcess(input: { sourceFileId: string; sourceLine: number; name: string }): string {
    return makeId('ClientSideProcess', [input.sourceFileId, input.sourceLine, input.name]);
  },

  databaseSystem(input: { kind: string; name: string }): string {
    return makeId('DatabaseSystem', [input.kind, input.name]);
  },

  databaseTable(input: { systemId: string; schema: string | null; name: string }): string {
    return makeId('DatabaseTable', [input.systemId, input.schema, input.name]);
  },

  databaseColumn(input: { tableId: string; name: string }): string {
    return makeId('DatabaseColumn', [input.tableId, input.name]);
  },

  databaseInteraction(input: {
    callSiteFunctionId: string;
    operation: string;
    targetTableId: string;
  }): string {
    return makeId('DatabaseInteraction', [input.callSiteFunctionId, input.operation, input.targetTableId]);
  },

  /**
   * Screen id (#187 schema bits).
   *
   * Includes `routePath` so two distinct web routes with the same
   * component name (e.g., a generic `<Page>` reused under different
   * paths) get distinct ids. RN producers pass `routePath: null` —
   * that hashes identically to the no-routePath case, preserving
   * existing RN screen identity across the schema bump.
   */
  screen(input: { repository: string; name: string; routePath?: string | null }): string {
    return makeId('Screen', [input.repository, input.name, input.routePath ?? null]);
  },

  environmentVariable(input: { sourceFileId: string; name: string; sourceLine: number }): string {
    return makeId('EnvironmentVariable', [input.sourceFileId, input.name, input.sourceLine]);
  },

  /**
   * StateStore id (#192). Keyed on (declaredIn, name) — two distinct
   * stores in different files don't collide; the same store re-emitted
   * across analyzer runs collapses to a single node.
   */
  stateStore(input: { declaredIn: string; name: string }): string {
    return makeId('StateStore', [input.declaredIn, input.name]);
  },
};
