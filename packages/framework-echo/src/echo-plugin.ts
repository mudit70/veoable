import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { createEchoVisitor } from './visitor.js';

/**
 * Echo framework plugin (Phase 5a of #474).
 *
 * Detects server-side API endpoints declared via the Echo routing API:
 *   e.GET("/path", handler)
 *   e.POST("/path", handler)
 *   e.Any("/path", handler)
 *   e.Match([]string{"GET","POST"}, "/path", handler)
 *
 * Group composition mirrors framework-gin:
 *   g := e.Group("/api")
 *   v1 := g.Group("/v1")
 *   v1.GET("/profile", getProfile)                →  /api/v1/profile
 *
 * Activates for projects with `labstack/echo` in go.mod. Per-file
 * `import` checks are the secondary guard.
 */
export const ECHO_PLUGIN_ID = 'echo' as const;

export class EchoPlugin implements FrameworkPlugin {
  readonly id = ECHO_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    if (
      hasGoModule(ctx, 'github.com/labstack/echo/v4')
      || hasGoModule(ctx, 'github.com/labstack/echo/v5')
      || hasGoModule(ctx, 'github.com/labstack/echo')
    ) return true;

    return ctx.files.some((f) => {
      if (!f.endsWith('.go')) return false;
      try {
        const content = fs.readFileSync(path.join(ctx.rootDir, f), 'utf-8');
        return content.includes('labstack/echo');
      } catch {
        return false;
      }
    });
  }

  readonly visitor: GoFrameworkVisitor = createEchoVisitor();
}
