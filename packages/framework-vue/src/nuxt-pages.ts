import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  idFor,
  type Screen,
  type SchemaNode,
  type SchemaEdge,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';

/**
 * Nuxt 3 file-based router (#370).
 *
 * Walks `<root>/pages/**\/*.vue` and emits one `Screen` node per
 * page. Path segments map to URL patterns the same way Nuxt's own
 * router resolves them:
 *
 *   pages/index.vue                → `/`
 *   pages/about.vue                → `/about`
 *   pages/users/[id].vue           → `/users/:id`
 *   pages/users/[...slug].vue      → `/users/:slug*`     (catch-all)
 *   pages/(auth)/login.vue         → `/login`            (route group)
 *
 * Nuxt 3 actually shares its bracket dynamic-segment syntax with
 * Next.js, so the normalisation here mirrors the Next.js extractor's
 * — we just walk `.vue` files instead of `.tsx`/`.jsx`.
 *
 * No SCREEN_COMPONENT edge is emitted at this layer. The component
 * function id can be wired up by a later resolver pass that lifts
 * the page's `<script setup>` or default export into the graph.
 */

const PAGE_EXTENSION = 'vue';

export interface NuxtPageFinding {
  /** URL pattern with `:param` segments. */
  routePath: string;
  /** Source file relative to rootDir (POSIX). */
  filePath: string;
}

/**
 * Walk `<root>/pages/` (and one common Nuxt-monorepo location
 * `app/pages/`) for `*.vue` files. Returns the URL pattern and
 * the source file path for each page.
 */
export function findNuxtPages(rootDir: string): NuxtPageFinding[] {
  const out: NuxtPageFinding[] = [];
  for (const candidate of ['pages', 'app/pages']) {
    const dir = path.join(rootDir, candidate);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      walk(dir, [], out, rootDir);
    }
  }
  return out;
}

function walk(dir: string, segments: string[], out: NuxtPageFinding[], rootDir: string): void {
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
      // Nuxt route group: `(auth)/login.vue` → `/login` (the group
      // segment is structural-only and contributes nothing to URL).
      const isRouteGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
      const childSegments = isRouteGroup
        ? segments
        : [...segments, normalizeSegment(entry.name)];
      walk(full, childSegments, out, rootDir);
    } else if (entry.isFile()) {
      if (!entry.name.endsWith(`.${PAGE_EXTENSION}`)) continue;
      const stem = entry.name.slice(0, -PAGE_EXTENSION.length - 1);
      const fileSegments = stem === 'index'
        ? [...segments]
        : [...segments, normalizeSegment(stem)];
      const routePath = fileSegments.length === 0 ? '/' : '/' + fileSegments.join('/');
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      out.push({ routePath, filePath: rel });
    }
  }
}

/**
 * Nuxt 3 dynamic-segment syntax (identical to Next.js):
 *   `[id]`        → `:id`
 *   `[...slug]`   → `:slug*`
 *   `[[...slug]]` → `:slug*`
 */
function normalizeSegment(seg: string): string {
  let m = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
  if (m) return `:${m[1]}*`;
  m = /^\[\.\.\.([^\]]+)\]$/.exec(seg);
  if (m) return `:${m[1]}*`;
  m = /^\[([^\]]+)\]$/.exec(seg);
  if (m) return `:${m[1]}`;
  return seg;
}

/**
 * Plugin-side entry: discover Nuxt pages under `rootDir` and emit
 * `Screen` nodes for each.
 */
export function extractNuxtScreens(rootDir: string, repository: string): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const seen = new Set<string>();

  for (const p of findNuxtPages(rootDir)) {
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
      framework: 'nuxt',
      repository,
    };
    nodes.push(screen);
  }

  return { nodes, edges };
}
