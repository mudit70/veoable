import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  idFor,
  type APIEndpoint,
  type SchemaEdge,
  type SchemaNode,
  type SourceFile,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { recordConfidenceDecision } from '@veoable/observability';

/**
 * Supabase Edge Functions discovery (#190).
 *
 * Edge Functions are server-side TS modules deployed to Supabase's
 * Deno runtime. The deploy convention places each function at:
 *
 *   <project-root>/supabase/functions/<name>/index.ts
 *
 * The deployed URL is canonically:
 *
 *   <SUPABASE_URL>/functions/v1/<name>
 *
 * For this analyzer's purposes, we emit one `APIEndpoint` per
 * discovered function with `routePattern: /functions/v1/<name>`. The
 * client-side `supabase.functions.invoke('<name>', ...)` detection
 * (#191) emits a `ClientSideAPICaller` with the same URL so the
 * existing flow stitcher can connect them.
 *
 * The HTTP method on Supabase Edge Functions is typically POST (the
 * canonical invocation form) but the function body can branch on
 * `req.method` to handle GET/PUT/DELETE/etc. We emit `POST` as the
 * primary endpoint and rely on the stitcher to match more loosely on
 * routePattern when method-narrowed matches fail.
 */

/**
 * Find every `supabase/functions/<name>/index.ts` under `rootDir`.
 * Returns an array of {name, indexPath} pairs. The names exclude
 * `_shared` and any directory starting with `.` or `_` (Supabase's
 * convention for shared/internal helpers).
 */
export function findEdgeFunctions(rootDir: string): Array<{ name: string; indexPath: string }> {
  const functionsDir = path.join(rootDir, 'supabase', 'functions');
  if (!fs.existsSync(functionsDir) || !fs.statSync(functionsDir).isDirectory()) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(functionsDir, { withFileTypes: true });
  } catch (err) {
    recordConfidenceDecision('supabase functions dir unreadable', {
      'supabase.path': functionsDir,
      'supabase.error': String(err instanceof Error ? err.message : err),
    });
    return [];
  }
  const out: Array<{ name: string; indexPath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith('.') || name.startsWith('_')) continue;

    // Canonical: supabase/functions/<name>/index.ts (or .tsx).
    for (const ext of ['ts', 'tsx', 'js', 'mjs']) {
      const candidate = path.join(functionsDir, name, `index.${ext}`);
      if (fs.existsSync(candidate)) {
        out.push({ name, indexPath: candidate });
        break;
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the canonical route pattern for a Supabase Edge Function:
 *   /functions/v1/<name>
 */
export function edgeFunctionRoutePattern(name: string): string {
  return `/functions/v1/${name}`;
}

/**
 * Discover all Edge Functions under `rootDir` and emit:
 *   - SourceFile node for each function's index file.
 *   - APIEndpoint with routePattern `/functions/v1/<name>`.
 *
 * The handlerFunctionId is null at this layer — Edge Function
 * handlers are typically `Deno.serve((req) => ...)` calls, which are
 * caller-style handlers; the language plugin's TS visitor can resolve
 * them later if/when a `framework-deno-serve` visitor is added.
 *
 * Returns an empty batch when no `supabase/functions/` directory
 * exists.
 */
export function extractEdgeFunctions(rootDir: string, repository: string): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];

  for (const fn of findEdgeFunctions(rootDir)) {
    const relPath = path
      .relative(rootDir, fn.indexPath)
      .split(path.sep)
      .join('/');

    const sourceFile: SourceFile = {
      nodeType: 'SourceFile',
      id: idFor.sourceFile({ repository, filePath: relPath }),
      filePath: relPath,
      repository,
      language: 'ts',
      framework: 'supabase-edge',
    };
    nodes.push(sourceFile);

    const routePattern = edgeFunctionRoutePattern(fn.name);
    const endpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository,
        httpMethod: 'POST',
        routePattern,
        filePath: relPath,
        lineStart: 1,
      }),
      httpMethod: 'POST',
      routePattern,
      handlerFunctionId: null,
      framework: 'supabase-edge',
      repository,
      evidence: {
        filePath: relPath,
        lineStart: 1,
        lineEnd: 1,
        snippet: `// Supabase Edge Function: ${fn.name}`,
        confidence: 'exact',
      },
    };
    nodes.push(endpoint);
  }

  return { nodes, edges };
}
