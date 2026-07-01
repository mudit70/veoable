import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Django URL-prefix resolver (#221).
 *
 * Walks every `urls.py` under the project root, extracts
 * `router.register(r'<resource>', <ViewSet>)` and
 * `path('<prefix>', include('<app>.urls'))` declarations, and
 * builds a `<ViewSet class name> → composed-prefix` map.
 *
 * Composition: a `ViewSet` registered in `myapp/urls.py` as
 * `router.register(r'articles', ArticleViewSet)` is mounted under
 * whatever prefix the project's main `urls.py` puts on `myapp.urls`
 * via `path('api/v2/', include('myapp.urls'))`. Composed prefix:
 * `/api/v2/articles/`.
 *
 * Regex-based — we don't need a full Python AST for this. Patterns
 * are highly regular and the false-positive surface is negligible.
 */

export interface DjangoUrlMap {
  /** ViewSet class name → composed URL prefix (NO trailing colon-id). */
  viewSetPrefix: ReadonlyMap<string, string>;
  /**
   * DRF function-based view → composed full route pattern.
   *
   * Matches `path("subpath", views.func_name)` and `path("subpath", func_name)`
   * declarations. Composed with parent `include()` prefixes to produce
   * the full path users hit (e.g. `/api/photos/upload-url`).
   *
   * Route params like `<uuid:photo_id>` are normalized to `:photo_id`
   * so they line up with the canonical-graph route convention.
   */
  functionRoute: ReadonlyMap<string, string>;
}

const REGISTER_RE = /router\.register\(\s*r?["']([^"']+)["']\s*,\s*(\w+(?:ViewSet|View))\b/g;
const INCLUDE_RE = /path\(\s*["']([^"']*)["']\s*,\s*include\(\s*["']([\w.]+)\.urls["']\s*\)/g;
// path("api/photos", views.list_photos)  OR  path("api/photos", list_photos)
// Excludes include(...) by requiring the value not to start with `include(`.
const PATH_FUNCTION_RE = /path\(\s*r?["']([^"']*)["']\s*,\s*(?!include\b)([\w.]+)\s*[,)]/g;
// re_path('^api/photos/$', views.list_photos)
const RE_PATH_FUNCTION_RE = /re_path\(\s*r?["']([^"']*)["']\s*,\s*(?!include\b)([\w.]+)\s*[,)]/g;

/**
 * Build a `<ViewSet class name>` → composed prefix map for a project.
 *
 * Walks the project rootDir for files named `urls.py`. Returns an
 * empty map when no urls.py is found (the visitor falls back to
 * the class-name heuristic).
 */
export function buildDjangoUrlMap(rootDir: string): DjangoUrlMap {
  const urlsFiles = findUrlsFiles(rootDir);
  if (urlsFiles.length === 0) {
    return { viewSetPrefix: new Map(), functionRoute: new Map() };
  }

  // ViewSet class name → { resource, appPath }. Last-write-wins on
  // class-name collision across modules — known limitation worth a
  // TODO if any real project hits it.
  const viewSetIndex = new Map<string, { resource: string; appPath: string }>();
  // Function-based view name → { subPath, appPath }.
  const functionIndex = new Map<string, { subPath: string; appPath: string }>();
  // App module's urls.py path (POSIX, relative to rootDir) → prefix
  // mounted by include() in the project's main urls.py.
  const inclusions = new Map<string, string>();

  // Single pass: per-file extract registrations + include() chains.
  for (const f of urlsFiles) {
    let content: string;
    try {
      content = fs.readFileSync(f.absPath, 'utf8');
    } catch {
      continue;
    }

    REGISTER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REGISTER_RE.exec(content)) !== null) {
      viewSetIndex.set(m[2], { resource: m[1], appPath: f.relPath });
    }

    INCLUDE_RE.lastIndex = 0;
    while ((m = INCLUDE_RE.exec(content)) !== null) {
      const prefix = m[1];
      const appModule = m[2]; // 'myapp' or 'project.apps.myapp'.
      const targetRel = appModule.split('.').join('/') + '/urls.py';
      if (!inclusions.has(targetRel)) inclusions.set(targetRel, normalizePrefix(prefix));
    }

    // Function-based view bindings. We extract `views.func_name` /
    // `func_name` from `path("subpath", <handler>)`.
    for (const re of [PATH_FUNCTION_RE, RE_PATH_FUNCTION_RE]) {
      re.lastIndex = 0;
      while ((m = re.exec(content)) !== null) {
        const subPath = m[1];
        const handler = m[2];
        const funcName = handler.includes('.') ? handler.split('.').pop()! : handler;
        // Skip ViewSet `.as_view()` style handlers — those are handled
        // by the class-name index above.
        if (handler.endsWith('.as_view')) continue;
        // Skip when name looks PascalCase (likely a class) — function
        // names are snake_case in real DRF code.
        if (/^[A-Z]/.test(funcName)) continue;
        // First-write-wins so adjacent path('') / path('foo') don't
        // overwrite each other.
        if (!functionIndex.has(funcName)) {
          functionIndex.set(funcName, { subPath, appPath: f.relPath });
        }
      }
    }
  }

  // Compose final prefixes.
  const viewSetPrefix = new Map<string, string>();
  for (const [className, reg] of viewSetIndex) {
    const includePrefix = findIncludePrefix(reg.appPath, inclusions);
    viewSetPrefix.set(className, composePrefix(includePrefix, reg.resource));
  }

  const functionRoute = new Map<string, string>();
  for (const [funcName, reg] of functionIndex) {
    const includePrefix = findIncludePrefix(reg.appPath, inclusions);
    functionRoute.set(funcName, composeFunctionRoute(includePrefix, reg.subPath));
  }

  return { viewSetPrefix, functionRoute };
}

/** Recursively walk `rootDir` for files named `urls.py`. */
function findUrlsFiles(rootDir: string): Array<{ absPath: string; relPath: string }> {
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
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
        walk(full);
      } else if (entry.isFile() && entry.name === 'urls.py') {
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

/**
 * Find the include() prefix for a given app's urls.py path.
 *
 * Tries exact match first, then `endsWith` to handle nested layouts
 * like `project.apps.myapp.urls`.
 */
function findIncludePrefix(
  appUrlsPath: string,
  inclusions: ReadonlyMap<string, string>,
): string {
  // Direct match: `myapp/urls.py`.
  const direct = inclusions.get(appUrlsPath);
  if (direct !== undefined) return direct;
  // Suffix match: any inclusion key ending with this path.
  for (const [key, prefix] of inclusions) {
    if (appUrlsPath.endsWith(key) || key.endsWith(appUrlsPath)) return prefix;
  }
  return '';
}

/** Normalize a prefix: strip leading/trailing slashes. */
function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Compose include-prefix + resource into a single URL pattern. */
function composePrefix(includePrefix: string, resource: string): string {
  const parts = [includePrefix, resource].filter((p) => p && p.length > 0);
  return '/' + parts.join('/');
}

/**
 * Compose include-prefix + subpath into a canonical-graph route.
 *
 * Normalizes Django path-converter syntax:
 *   `<int:pk>`, `<str:slug>`, `<uuid:photo_id>` → `:pk`, `:slug`, `:photo_id`
 *   `<photo_id>` (untyped) → `:photo_id`
 * Strips Python-regex anchors from re_path() subpaths:
 *   `^api/photos/$` → `api/photos/`
 *   `\\Aapi/photos\\Z` → `api/photos`
 * Trailing slash on `subPath` is preserved when present (after
 * anchor stripping). If subPath is exactly `/`, the trailing slash
 * is preserved by treating the empty-but-trailing case explicitly.
 */
function composeFunctionRoute(includePrefix: string, subPath: string): string {
  // Strip regex anchors first so subPath="^/$" reduces to "/", not "".
  const dewedged = stripRegexAnchors(subPath);
  const trailing = dewedged.endsWith('/');
  const stripped = dewedged.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = [includePrefix, stripped].filter((p) => p && p.length > 0);
  const joined = parts.join('/');
  const normalized = joined.replace(
    /<(?:[a-zA-Z_][\w]*:)?([a-zA-Z_][\w]*)>/g,
    ':$1',
  );
  // Preserve trailing slash even when the subPath reduces to empty
  // (i.e. subPath was literally "/", or an anchored "^/$"). Without
  // this guard, composeFunctionRoute("api", "/") returned "/api"
  // instead of "/api/".
  const suffix = trailing && (stripped || includePrefix) ? '/' : '';
  return '/' + normalized + suffix;
}

/**
 * Strip Python-regex anchors that re_path() declarations commonly
 * include. Without this, `re_path(r"^api/photos/$", ...)` composed
 * with an include prefix produces `/<prefix>/^api/photos/$` — a
 * useless routePattern that won't match anything in the stitcher.
 *
 * Handles:
 *   - leading `^`, `\A`
 *   - trailing `$`, `\Z`
 *
 * Idempotent and safe to call on plain `path()` subpaths too.
 */
function stripRegexAnchors(subPath: string): string {
  return subPath.replace(/^(?:\^|\\A)/, '').replace(/(?:\$|\\Z)$/, '');
}
