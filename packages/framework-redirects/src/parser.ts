import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  idFor,
  type NavigatesToEdge,
  type Screen,
  type SchemaEdge,
  type SchemaNode,
  type SourceFile,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { recordConfidenceDecision } from '@veoable/observability';

/**
 * firebase.json / vercel.json redirect-map extractor (#198 PR3e).
 *
 * Hosting providers declare static redirects in their config files.
 * Examples:
 *
 *   firebase.json:
 *     {
 *       "hosting": {
 *         "redirects": [
 *           { "source": "/try", "destination": "/signup", "type": 301 }
 *         ]
 *       }
 *     }
 *
 *   vercel.json:
 *     {
 *       "redirects": [
 *         { "source": "/try", "destination": "/signup", "permanent": true }
 *       ]
 *     }
 *
 * For each well-formed redirect entry the parser emits:
 *   - SourceFile node for the config file (firebase.json / vercel.json).
 *   - Screen for the source URL (framework: 'redirects').
 *   - Screen for the destination URL.
 *   - NAVIGATES_TO edge with method=`redirect-<status>`.
 *
 * The Screen IDs are content-addressed via `idFor.screen({repository,
 * name, routePath})`, so when another producer (lang-html SSG,
 * react-router) emits the destination Screen the IDs collapse and the
 * canonical store de-dupes naturally.
 *
 * Cap on entries: a malformed config with thousands of entries
 * shouldn't OOM the analyzer. Hard-capped at 5000 — anything beyond
 * is an obvious mistake.
 */

const MAX_REDIRECT_ENTRIES = 5000;

export interface RedirectFinding {
  /** Path of the config file this entry came from (relative to rootDir). */
  configFilePath: string;
  /** The source URL (e.g., `/try`). */
  source: string;
  /** The destination URL (e.g., `/signup`). */
  destination: string;
  /** HTTP redirect status. firebase: `type` (number); vercel: `permanent` (bool → 308 / 307). */
  status: number;
}

/**
 * Find firebase.json and vercel.json at the project root and return
 * any redirects declared in them. Returns an empty array when neither
 * file exists. Malformed JSON is silently skipped (the analyzer
 * shouldn't fail because a single config file is invalid).
 */
export function findRedirectConfigs(rootDir: string): {
  firebase: string | null;
  vercel: string | null;
} {
  const firebase = path.join(rootDir, 'firebase.json');
  const vercel = path.join(rootDir, 'vercel.json');
  return {
    firebase: fs.existsSync(firebase) ? firebase : null,
    vercel: fs.existsSync(vercel) ? vercel : null,
  };
}

/**
 * Parse a single config file's redirects. Returns an empty array on
 * any error (malformed JSON, missing redirects array, etc.) — the
 * tradeoff is silent skip vs. crashing the analyzer; we choose
 * silent + a ConfidenceDecision so the gap surfaces in observability.
 */
export function parseRedirects(
  configPath: string,
  source: 'firebase' | 'vercel',
  configFilePathRelative: string,
): RedirectFinding[] {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    recordConfidenceDecision(`${source}.json read failed`, {
      'redirects.path': configPath,
      'redirects.error': String(err instanceof Error ? err.message : err),
    });
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    recordConfidenceDecision(`${source}.json malformed JSON`, {
      'redirects.path': configPath,
      'redirects.error': String(err instanceof Error ? err.message : err),
    });
    return [];
  }

  const list = source === 'firebase'
    ? extractFirebaseRedirects(parsed)
    : extractVercelRedirects(parsed);

  if (list.length > MAX_REDIRECT_ENTRIES) {
    recordConfidenceDecision(`${source}.json redirects exceed cap`, {
      'redirects.cap': MAX_REDIRECT_ENTRIES,
      'redirects.actual': list.length,
    });
    list.length = MAX_REDIRECT_ENTRIES;
  }

  const out: RedirectFinding[] = [];
  for (const entry of list) {
    if (!entry) continue;
    const src = typeof entry.source === 'string' ? entry.source : null;
    const dst = typeof entry.destination === 'string' ? entry.destination : null;
    if (!src || !dst) continue;
    if (!src.startsWith('/') && !src.startsWith('http')) continue;
    if (!dst.startsWith('/') && !dst.startsWith('http')) continue;
    let status = 302;
    if (typeof entry.type === 'number') status = entry.type;
    if (typeof entry.permanent === 'boolean') status = entry.permanent ? 308 : 307;
    if (typeof entry.statusCode === 'number') status = entry.statusCode;
    out.push({ configFilePath: configFilePathRelative, source: src, destination: dst, status });
  }
  return out;
}

interface RedirectRecord {
  source?: unknown;
  destination?: unknown;
  type?: unknown;
  permanent?: unknown;
  statusCode?: unknown;
}

function extractFirebaseRedirects(parsed: unknown): RedirectRecord[] {
  if (!parsed || typeof parsed !== 'object') return [];
  // Single-target shape: { hosting: { redirects: [...] } }
  // Multi-target shape: { hosting: [{ target: 'x', redirects: [...] }, ...] }
  const hosting = (parsed as { hosting?: unknown }).hosting;
  if (!hosting) return [];
  if (Array.isArray(hosting)) {
    const out: RedirectRecord[] = [];
    for (const target of hosting) {
      if (target && typeof target === 'object') {
        const r = (target as { redirects?: unknown }).redirects;
        if (Array.isArray(r)) out.push(...(r as RedirectRecord[]));
      }
    }
    return out;
  }
  if (typeof hosting === 'object') {
    const r = (hosting as { redirects?: unknown }).redirects;
    if (Array.isArray(r)) return r as RedirectRecord[];
  }
  return [];
}

function extractVercelRedirects(parsed: unknown): RedirectRecord[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const r = (parsed as { redirects?: unknown }).redirects;
  return Array.isArray(r) ? (r as RedirectRecord[]) : [];
}

/**
 * Extract redirect Screens + edges across firebase.json and
 * vercel.json under `rootDir`. Returns a NodeBatch containing the
 * SourceFile node(s) for the config file(s), the Screen pairs
 * (source + destination), and the NAVIGATES_TO edges between them.
 *
 * Empty batch when neither config file exists.
 */
export function extractRedirects(rootDir: string, repository: string): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const seenScreenIds = new Set<string>();

  const { firebase, vercel } = findRedirectConfigs(rootDir);
  for (const cfg of [
    firebase ? { kind: 'firebase' as const, abs: firebase, rel: 'firebase.json' } : null,
    vercel ? { kind: 'vercel' as const, abs: vercel, rel: 'vercel.json' } : null,
  ]) {
    if (!cfg) continue;

    // #293 — concrete framework label. Pre-fix every JSON redirects
    // config got `framework: 'redirects'` — too generic, polluted
    // describe_architecture / framework groupings, and obscured WHICH
    // host's config (vercel vs firebase) the file was for. Use the
    // host name so consumers can group/filter meaningfully.
    const sourceFileFramework = cfg.kind === 'firebase' ? 'firebase-config' : 'vercel-config';
    const sourceFile: SourceFile = {
      nodeType: 'SourceFile',
      id: idFor.sourceFile({ repository, filePath: cfg.rel }),
      filePath: cfg.rel,
      repository,
      language: 'json',
      framework: sourceFileFramework,
    };
    nodes.push(sourceFile);

    const findings = parseRedirects(cfg.abs, cfg.kind, cfg.rel);
    // Synthetic 1-based ordinal in lieu of actual JSON line numbers.
    // We don't tokenize the JSON, so `lineCounter` here is the
    // entry's index within the redirects array — sufficient for a
    // stable Screen id (the line is included in idFor inputs) but
    // NOT the file's real source line.
    let lineCounter = 1;
    for (const f of findings) {
      const fromScreenId = idFor.screen({
        repository,
        name: f.source,
        routePath: f.source,
      });
      const toScreenId = idFor.screen({
        repository,
        name: f.destination,
        routePath: f.destination,
      });

      if (!seenScreenIds.has(fromScreenId)) {
        seenScreenIds.add(fromScreenId);
        const fromScreen: Screen = {
          nodeType: 'Screen',
          id: fromScreenId,
          name: f.source,
          componentFunctionId: null,
          navigatorKind: 'web-router',
          routePath: f.source,
          parentScreenId: null,
          sourceFileId: sourceFile.id,
          sourceLine: lineCounter,
          framework: 'redirects',
          repository,
        };
        nodes.push(fromScreen);
      }

      if (!seenScreenIds.has(toScreenId)) {
        seenScreenIds.add(toScreenId);
        const toScreen: Screen = {
          nodeType: 'Screen',
          id: toScreenId,
          name: f.destination,
          componentFunctionId: null,
          navigatorKind: 'web-router',
          routePath: f.destination,
          parentScreenId: null,
          sourceFileId: sourceFile.id,
          sourceLine: lineCounter,
          framework: 'redirects',
          repository,
        };
        nodes.push(toScreen);
      }

      const edge: NavigatesToEdge = {
        edgeType: 'NAVIGATES_TO',
        from: fromScreenId,
        to: toScreenId,
        method: `redirect-${f.status}`,
        sourceLine: lineCounter,
      };
      edges.push(edge);
      lineCounter += 1;
    }
  }

  return { nodes, edges };
}
