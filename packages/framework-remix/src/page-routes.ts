import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  idFor,
  type Screen,
  type SchemaEdge,
  type SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { filePathToRoutePattern } from './route-convention.js';

/**
 * Remix page-as-Screen extractor (#198 PR3c).
 *
 * Walks `<root>/app/routes/` for `.tsx`/`.jsx`/`.ts`/`.js` files.
 * Each becomes a Screen whose routePath is computed by the existing
 * `filePathToRoutePattern` (handles `$param` segments, `_layout` /
 * `_index` conventions, dotted path separators).
 */

const ROUTE_EXTENSIONS: ReadonlySet<string> = new Set(['tsx', 'jsx', 'ts', 'js']);

export interface RemixPageFinding {
  routePath: string;
  filePath: string;
}

export function findRemixRoutes(rootDir: string): RemixPageFinding[] {
  const routesDir = path.join(rootDir, 'app', 'routes');
  if (!fs.existsSync(routesDir) || !fs.statSync(routesDir).isDirectory()) return [];

  const out: RemixPageFinding[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(routesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const dotIdx = entry.name.lastIndexOf('.');
    if (dotIdx < 0) continue;
    const ext = entry.name.slice(dotIdx + 1);
    if (!ROUTE_EXTENSIONS.has(ext)) continue;

    // Build the relative path Remix's route-convention parser expects.
    const rel = path.relative(rootDir, path.join(routesDir, entry.name)).split(path.sep).join('/');
    const routePattern = filePathToRoutePattern(rel);
    if (!routePattern) continue;
    out.push({ routePath: routePattern, filePath: rel });
  }
  return out;
}

/**
 * Emit Screen nodes for every Remix route file found.
 */
export function extractRemixPages(rootDir: string, repository: string): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const seen = new Set<string>();

  for (const p of findRemixRoutes(rootDir)) {
    const screenId = idFor.screen({
      repository,
      name: p.routePath,
      routePath: p.routePath,
    });
    if (seen.has(screenId)) continue;
    seen.add(screenId);

    const sourceFileId = idFor.sourceFile({ repository, filePath: p.filePath });
    const screen: Screen = {
      nodeType: 'Screen',
      id: screenId,
      name: p.routePath,
      componentFunctionId: null,
      navigatorKind: 'web-router',
      routePath: p.routePath,
      parentScreenId: null,
      sourceFileId,
      sourceLine: 1,
      framework: 'remix',
      repository,
    };
    nodes.push(screen);
  }

  return { nodes, edges };
}
