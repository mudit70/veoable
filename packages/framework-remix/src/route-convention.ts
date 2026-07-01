/**
 * Remix v2 flat-file route convention parser.
 *
 * Converts a route filename (relative to `app/routes/`) into a URL pattern.
 *
 * Rules:
 *   - Strip the file extension
 *   - `.` → `/` (path separator)
 *   - `$` prefix on a segment → `:param` (dynamic segment)
 *   - `_index` → index route (maps to parent path, i.e. empty suffix)
 *   - `_` prefix on a segment → pathless layout (segment is removed from URL)
 *   - `($segment)` → optional segment (parenthesized)
 *
 * Examples:
 *   users.tsx              → /users
 *   users.$id.tsx          → /users/:id
 *   users._index.tsx       → /users
 *   _auth.login.tsx        → /login
 *   api.health.tsx         → /api/health
 *   api.users.$id.tsx      → /api/users/:id
 */

export function filePathToRoutePattern(routeFilePath: string): string | null {
  // Extract the filename without extension, relative to app/routes/
  const routesIdx = routeFilePath.indexOf('app/routes/');
  if (routesIdx === -1) return null;

  let name = routeFilePath.slice(routesIdx + 'app/routes/'.length);

  // Strip extension
  const extIdx = name.lastIndexOf('.');
  if (extIdx > 0) {
    const ext = name.slice(extIdx);
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts'].includes(ext)) {
      name = name.slice(0, extIdx);
    }
  }

  // Handle _index — maps to the parent path
  if (name === '_index') return '/';
  if (name.endsWith('._index')) {
    name = name.slice(0, -'._index'.length);
  }

  // Split on `.` which is the path separator in Remix flat files
  const segments = name.split('.');
  const urlSegments: string[] = [];

  for (const segment of segments) {
    // Leading `_` means pathless layout — skip this segment
    if (segment.startsWith('_') && !segment.startsWith('$')) {
      continue;
    }

    // Dynamic segment: `$param` → `:param`
    if (segment.startsWith('$')) {
      const paramName = segment.slice(1);
      if (paramName === '') {
        // Splat route: `$` alone → `*`
        urlSegments.push('*');
      } else {
        urlSegments.push(`:${paramName}`);
      }
    } else {
      urlSegments.push(segment);
    }
  }

  const pattern = '/' + urlSegments.join('/');
  return pattern;
}
