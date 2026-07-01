import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Cross-file include_router prefix resolver.
 *
 * Real FastAPI projects split routers across files:
 *
 *   # main.py
 *   from routers import tasks
 *   app.include_router(tasks.router, prefix="/api")
 *
 *   # routers/tasks.py
 *   router = APIRouter(prefix="/tasks")
 *   @router.get("")            # → /api/tasks
 *
 * The per-file `scanModuleForPrefixes` in `visitor.ts` only sees the
 * router decl in tasks.py and never learns about `/api`. This
 * resolver runs once at project load — it walks every `.py` file and
 * builds a map of `<absolute-module>:<router-id>` → composed prefix
 * (include + router's own).
 *
 * The visitor consults this map keyed by `<router-id>` (bare name).
 * Last-write-wins on cross-module collisions — acceptable for our
 * scope; a future iteration can disambiguate by module path.
 */

export interface IncludeRouterMap {
  /** Router identifier → composed full URL prefix. */
  composedPrefixByRouterId: ReadonlyMap<string, string>;
}

interface RouterDecl {
  /** Module path relative to rootDir, dot-separated (e.g. `routers.tasks`). */
  modulePath: string;
  /** Router variable name (e.g. `router`). */
  routerId: string;
  /** Own prefix from APIRouter(prefix="...") — already slash-normalized. */
  ownPrefix: string;
}

interface IncludeCall {
  /** Module reference as written, e.g. `tasks.router` or `router`. */
  callExpr: string;
  /** Prefix string from include_router(..., prefix="..."). */
  includePrefix: string;
  /** File where the include_router call lives. */
  fileModulePath: string;
  /** Map of `<local name> → <module path>` imports in the calling file. */
  imports: ReadonlyMap<string, string>;
}

const ROUTER_DECL_RE = /([A-Za-z_][\w]*)\s*=\s*APIRouter\s*\(([^)]*)\)/g;
const PREFIX_KW_RE = /\bprefix\s*=\s*["']([^"']*)["']/;
// Locate the start of an `.include_router(...)` call. The tail is
// extracted by a balanced-paren scan in `extractIncludeCalls` — the
// regex itself only finds the head and the target expression so we
// don't truncate on nested parens like `tags=("a", "b")`.
const INCLUDE_HEAD_RE = /\.include_router\s*\(\s*([\w.]+)\s*/g;
// Single-line `from X import a, b` form.
const FROM_IMPORT_RE = /^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w*][\w,\s]*)\s*$/gm;
// Multiline `from X import (a, b, c)` form, possibly with trailing
// commas across lines.
const FROM_IMPORT_PAREN_RE = /^\s*from\s+(\.*)([\w.]*)\s+import\s*\(([^)]*)\)/gm;
const IMPORT_RE = /^\s*import\s+([\w.]+)(?:\s+as\s+([\w]+))?\s*$/gm;

/**
 * Walk `rootDir` for `.py` files and build the cross-file map.
 */
export function buildIncludeRouterMap(rootDir: string): IncludeRouterMap {
  const pyFiles = findPyFiles(rootDir);
  if (pyFiles.length === 0) return { composedPrefixByRouterId: new Map() };

  const routerDecls: RouterDecl[] = [];
  const includeCalls: IncludeCall[] = [];

  for (const file of pyFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file.absPath, 'utf8');
    } catch {
      continue;
    }
    const modulePath = file.relPath.replace(/\.py$/, '').split('/').join('.');

    // Router declarations.
    ROUTER_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTER_DECL_RE.exec(content)) !== null) {
      const routerId = m[1]!;
      const kwargs = m[2]!;
      const prefixMatch = PREFIX_KW_RE.exec(kwargs);
      const ownPrefix = normalizePrefix(prefixMatch?.[1] ?? '');
      routerDecls.push({ modulePath, routerId, ownPrefix });
    }

    // include_router calls — capture both the target expression and
    // any local `from X import Y` / `import X` aliases in the file.
    const imports = scanImports(content, modulePath);
    INCLUDE_HEAD_RE.lastIndex = 0;
    while ((m = INCLUDE_HEAD_RE.exec(content)) !== null) {
      const callExpr = m[1]!;
      // Balanced-paren scan from the head's end to the matching `)`.
      // Tracks `(` `)` depth and skips string contents so nested
      // tuples like `tags=("a", "b")` don't end the kwargs early.
      const tail = readBalancedKwargs(content, INCLUDE_HEAD_RE.lastIndex);
      const prefixMatch = PREFIX_KW_RE.exec(tail);
      const includePrefix = normalizePrefix(prefixMatch?.[1] ?? '');
      includeCalls.push({ callExpr, includePrefix, fileModulePath: modulePath, imports });
    }
  }

  // Compose: for each router decl, find the include_router call whose
  // target resolves to (decl.modulePath, decl.routerId), then compose
  // includePrefix + ownPrefix.
  const composed = new Map<string, string>();
  for (const decl of routerDecls) {
    const includePrefix = findMatchingIncludePrefix(decl, includeCalls);
    composed.set(decl.routerId, composeRoute(includePrefix, decl.ownPrefix));
  }
  return { composedPrefixByRouterId: composed };
}

/**
 * Match an include_router call against a router declaration.
 *
 * Supported call expressions:
 *   - `router`              → bare; matches when caller is in the same module.
 *   - `tasks.router`        → resolves `tasks` via `from routers import tasks`
 *                             or `import routers.tasks as tasks`.
 *   - `routers.tasks.router` → direct module path.
 */
function findMatchingIncludePrefix(
  decl: RouterDecl,
  includeCalls: readonly IncludeCall[],
): string {
  for (const call of includeCalls) {
    const parts = call.callExpr.split('.');
    // Last segment is the router id.
    const callRouterId = parts[parts.length - 1]!;
    if (callRouterId !== decl.routerId) continue;
    const prefixParts = parts.slice(0, -1);

    if (prefixParts.length === 0) {
      // Bare `router`: only valid in the same module.
      if (call.fileModulePath === decl.modulePath) return call.includePrefix;
      continue;
    }

    // Try to resolve `prefixParts` against the file's imports.
    const head = prefixParts[0]!;
    const aliasTarget = call.imports.get(head);
    let candidate: string;
    if (aliasTarget) {
      candidate = [aliasTarget, ...prefixParts.slice(1)].join('.');
    } else {
      candidate = prefixParts.join('.');
    }
    if (candidate === decl.modulePath) return call.includePrefix;
    // Also accept when the candidate matches the decl module's tail.
    if (decl.modulePath.endsWith('.' + candidate) || decl.modulePath === candidate) {
      return call.includePrefix;
    }
  }
  return '';
}

/**
 * Extract `from X import Y` and `import X as Y` aliases.
 *
 *   from routers import tasks         → tasks → routers.tasks
 *   from routers.tasks import router  → router → routers.tasks.router
 *   import routers.tasks as tasks     → tasks → routers.tasks
 *   import routers.tasks              → routers.tasks → routers.tasks
 *
 * Relative imports are resolved against `fileModulePath`:
 *
 *   # in app.routers.main
 *   from . import tasks               → tasks → app.routers.tasks
 *   from .. import shared             → shared → app.shared
 *   from .api import users            → users → app.routers.api.users
 *
 * Multiline parenthesised forms (`from x import (a, b, c)`) are also
 * supported.
 */
function scanImports(content: string, fileModulePath: string): Map<string, string> {
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;

  FROM_IMPORT_RE.lastIndex = 0;
  while ((m = FROM_IMPORT_RE.exec(content)) !== null) {
    const dots = m[1] ?? '';
    const tail = m[2] ?? '';
    const module = resolveImportModule(dots, tail, fileModulePath);
    const names = m[3]!.split(',').map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      out.set(name, module ? `${module}.${name}` : name);
    }
  }

  FROM_IMPORT_PAREN_RE.lastIndex = 0;
  while ((m = FROM_IMPORT_PAREN_RE.exec(content)) !== null) {
    const dots = m[1] ?? '';
    const tail = m[2] ?? '';
    const module = resolveImportModule(dots, tail, fileModulePath);
    const entries = m[3]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of entries) {
      // Each entry is either `name` or `name as alias`. The local
      // binding key in the file is the alias when present.
      const asMatch = /^([\w*]+)\s+as\s+(\w+)$/.exec(entry);
      const original = asMatch ? asMatch[1]! : entry;
      const localName = asMatch ? asMatch[2]! : entry;
      out.set(localName, module ? `${module}.${original}` : original);
    }
  }

  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const module = m[1]!;
    const alias = m[2] ?? module.split('.')[0];
    out.set(alias!, module);
  }
  return out;
}

/**
 * Resolve a `from X import …` module reference, taking relative-import
 * dots into account.
 *
 *   resolveImportModule('',   'routers',  'app.main')          → 'routers'
 *   resolveImportModule('.',  '',         'app.main')          → 'app'
 *   resolveImportModule('.',  'routers',  'app.main')          → 'app.routers'
 *   resolveImportModule('..', '',         'app.sub.main')      → 'app'
 *   resolveImportModule('..', 'shared',   'app.sub.main')      → 'app.shared'
 */
function resolveImportModule(dots: string, tail: string, fileModulePath: string): string {
  if (dots.length === 0) return tail;
  // One dot means "current package" (= parent module of this file).
  // Two dots = grandparent, etc.
  const parts = fileModulePath.split('.');
  const upLevels = dots.length;
  // Pop one for the file itself, then `upLevels - 1` for each extra dot.
  const baseParts = parts.slice(0, Math.max(0, parts.length - upLevels));
  const tailParts = tail ? tail.split('.') : [];
  return [...baseParts, ...tailParts].filter(Boolean).join('.');
}

/**
 * Read the kwargs portion of an `.include_router(target, …)` call,
 * starting just after `target` has been consumed by INCLUDE_HEAD_RE.
 * Returns the substring up to (but not including) the closing `)` of
 * the call, tracking paren/bracket/brace depth and skipping string
 * literals so nested tuples and dicts don't terminate it early.
 */
function readBalancedKwargs(content: string, startIdx: number): string {
  let depth = 1;
  let i = startIdx;
  let strQuote: '"' | "'" | null = null;
  for (; i < content.length; i++) {
    const ch = content[i]!;
    if (strQuote !== null) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === strQuote) strQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      strQuote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return content.slice(startIdx, i);
    }
  }
  return content.slice(startIdx);
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

function composeRoute(includePrefix: string, ownPrefix: string): string {
  const parts = [includePrefix, ownPrefix].filter((p) => p.length > 0);
  return parts.length === 0 ? '' : '/' + parts.join('/');
}

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.git',
  'dist',
  'build',
  'site-packages',
]);

function findPyFiles(rootDir: string): Array<{ absPath: string; relPath: string }> {
  const out: Array<{ absPath: string; relPath: string }> = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        out.push({
          absPath: full,
          relPath: path.relative(rootDir, full).split(path.sep).join('/'),
        });
      }
    }
  };
  walk(rootDir);
  return out;
}
