import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  idFor,
  type Screen,
  type SchemaEdge,
  type SchemaNode,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';

/**
 * SvelteKit page-as-Screen extractor (#198 PR3c).
 *
 * Walks `<root>/src/routes/` for `+page.{svelte,ts,js}` files. Each
 * becomes a Screen whose URL is the directory path with SvelteKit's
 * dynamic / catch-all conventions:
 *   - `[param]` → `:param` (dynamic).
 *   - `[...slug]` → `:slug*` (catch-all rest).
 *   - `(group)` → omitted (route group).
 *   - `[[optional]]` → `:optional?` (optional segment).
 *
 * `+layout.svelte` files are NOT emitted as Screens — they're
 * shared shells, not destination pages.
 */

const PAGE_NAMES: ReadonlyArray<string> = [
  '+page.svelte', '+page.ts', '+page.js',
  '+page.server.ts', '+page.server.js',
];

export interface SveltePageFinding {
  routePath: string;
  filePath: string;
}

export function findSvelteKitRoutes(rootDir: string): SveltePageFinding[] {
  const routesDir = path.join(rootDir, 'src', 'routes');
  if (!fs.existsSync(routesDir) || !fs.statSync(routesDir).isDirectory()) return [];
  const out: SveltePageFinding[] = [];
  walk(routesDir, [], out, rootDir);
  return out;
}

function walk(
  dir: string,
  segments: string[],
  out: SveltePageFinding[],
  rootDir: string,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // First pass: emit the page if this directory has a +page file.
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!PAGE_NAMES.includes(entry.name)) continue;
    // Prefer +page.svelte for the Screen's source file id; if absent
    // fall back to the +page.{ts,js,server.ts,server.js} present.
    const svelteFile = entries.find((e) => e.isFile() && e.name === '+page.svelte');
    const filename = svelteFile?.name ?? entry.name;
    const full = path.join(dir, filename);
    const rel = path.relative(rootDir, full).split(path.sep).join('/');
    const routePath = '/' + segments.join('/');
    out.push({ routePath: routePath === '/' ? '/' : routePath, filePath: rel });
    // Don't emit twice if multiple +page files exist in the same dir.
    break;
  }
  // Second pass: recurse subdirectories.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const isRouteGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
    const childSegments = isRouteGroup ? segments : [...segments, normalizeSegment(entry.name)];
    walk(path.join(dir, entry.name), childSegments, out, rootDir);
  }
}

/**
 * Convert a SvelteKit dynamic segment to URL-pattern form:
 *   `[param]`     → `:param`
 *   `[[optional]]` → `:optional?`
 *   `[...slug]`   → `:slug*`
 */
function normalizeSegment(seg: string): string {
  let m = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
  if (m) return `:${m[1]}*`;
  m = /^\[\.\.\.([^\]]+)\]$/.exec(seg);
  if (m) return `:${m[1]}*`;
  m = /^\[\[([^\]]+)\]\]$/.exec(seg);
  if (m) return `:${m[1]}?`;
  m = /^\[([^\]]+)\]$/.exec(seg);
  if (m) return `:${m[1]}`;
  return seg;
}

/**
 * Emit Screen nodes for every SvelteKit page found.
 */
export function extractSveltePages(rootDir: string, repository: string): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const seen = new Set<string>();

  for (const p of findSvelteKitRoutes(rootDir)) {
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
      framework: 'sveltekit',
      repository,
    };
    nodes.push(screen);
  }

  return { nodes, edges };
}
