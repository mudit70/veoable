import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  idFor,
  type Screen,
  type SchemaNode,
  type SchemaEdge,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';

/**
 * Next.js page-as-Screen extractor (#198 PR3c).
 *
 * Two coexisting routers:
 *   1. App Router (Next.js 13+):
 *      app/<seg1>/<seg2>/page.{tsx,jsx,ts,js}
 *      - `[id]` → `:id` (dynamic).
 *      - `[...slug]` → `:slug*` (catch-all).
 *      - `[[...slug]]` → `:slug*` (optional catch-all; same URL shape).
 *      - `(group)` → omitted from URL (route group).
 *   2. Pages Router (legacy):
 *      pages/<seg>/<seg>.{tsx,jsx,ts,js}
 *      - `pages/_app.{tsx,jsx,...}`, `pages/_document.*` excluded.
 *      - `pages/api/*` excluded (handled as APIEndpoint elsewhere).
 *      - `index.<ext>` → URL ends at parent directory.
 */

const PAGE_EXTENSIONS: ReadonlyArray<string> = ['tsx', 'jsx', 'ts', 'js'];

export interface PageFinding {
  /** URL pattern with `:param` segments. */
  routePath: string;
  /** Source file relative to rootDir (POSIX). */
  filePath: string;
  /** Which router produced this finding. */
  router: 'app' | 'pages';
}

/**
 * Walk `<root>/app/` for `page.<ext>` files. Returns the URL pattern
 * (with `:param` segments) and the source file path for each.
 */
export function findAppRouterPages(rootDir: string): PageFinding[] {
  const appDir = path.join(rootDir, 'app');
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) return [];
  const out: PageFinding[] = [];
  walkAppRouter(appDir, [], out, rootDir);
  return out;
}

function walkAppRouter(
  dir: string,
  segments: string[],
  out: PageFinding[],
  rootDir: string,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      // Route groups `(name)` don't contribute to the URL.
      const isRouteGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
      const childSegments = isRouteGroup ? segments : [...segments, normalizeSegment(entry.name)];
      walkAppRouter(full, childSegments, out, rootDir);
    } else if (entry.isFile()) {
      const stem = entry.name.replace(/\.(tsx|jsx|ts|js)$/, '');
      const ext = entry.name.slice(stem.length + 1);
      if (stem !== 'page') continue;
      if (!PAGE_EXTENSIONS.includes(ext)) continue;
      const routePath = segments.length === 0 ? '/' : '/' + segments.join('/');
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      out.push({ routePath, filePath: rel, router: 'app' });
    }
  }
}

/**
 * Walk `<root>/pages/` for page files. Excludes `_app`, `_document`,
 * and the `api/` subtree.
 */
export function findPagesRouterPages(rootDir: string): PageFinding[] {
  const pagesDir = path.join(rootDir, 'pages');
  if (!fs.existsSync(pagesDir) || !fs.statSync(pagesDir).isDirectory()) return [];
  const out: PageFinding[] = [];
  walkPagesRouter(pagesDir, [], out, rootDir);
  return out;
}

function walkPagesRouter(
  dir: string,
  segments: string[],
  out: PageFinding[],
  rootDir: string,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.name === 'api' && segments.length === 0) continue; // API routes handled elsewhere.
      walkPagesRouter(full, [...segments, normalizeSegment(entry.name)], out, rootDir);
    } else if (entry.isFile()) {
      const stem = entry.name.replace(/\.(tsx|jsx|ts|js)$/, '');
      const ext = entry.name.slice(stem.length + 1);
      if (!PAGE_EXTENSIONS.includes(ext)) continue;
      // Excluded special files in the Pages Router.
      if (segments.length === 0 && (stem === '_app' || stem === '_document' || stem === '_error')) continue;

      const fileSegments = stem === 'index'
        ? [...segments]
        : [...segments, normalizeSegment(stem)];
      const routePath = '/' + fileSegments.join('/');
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      out.push({
        routePath: routePath === '/' ? '/' : routePath,
        filePath: rel,
        router: 'pages',
      });
    }
  }
}

/**
 * Convert a Next.js dynamic segment to URL-pattern form:
 *   `[id]` → `:id`
 *   `[...slug]` → `:slug*`
 *   `[[...slug]]` → `:slug*`
 *   `(group)` → '' (signals route-group, caller filters before
 *               calling here)
 */
function normalizeSegment(seg: string): string {
  // [[...slug]] (optional catch-all)
  let m = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
  if (m) return `:${m[1]}*`;
  // [...slug] (catch-all)
  m = /^\[\.\.\.([^\]]+)\]$/.exec(seg);
  if (m) return `:${m[1]}*`;
  // [id]
  m = /^\[([^\]]+)\]$/.exec(seg);
  if (m) return `:${m[1]}`;
  return seg;
}

/**
 * Discover all Next.js pages (App + Pages Routers) and emit Screen
 * nodes for each. The component function id is null at this layer —
 * the lang-ts visitor independently emits FunctionDefinitions for
 * the page component, and the SCREEN_COMPONENT edge can be added by
 * a later resolver pass.
 */
export function extractNextjsPages(rootDir: string, repository: string): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const seen = new Set<string>();

  const allPages = [...findAppRouterPages(rootDir), ...findPagesRouterPages(rootDir)];
  for (const p of allPages) {
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
      framework: `nextjs-${p.router}`,
      repository,
    };
    nodes.push(screen);
  }

  return { nodes, edges };
}
