import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasGoModule } from '@veoable/plugin-api';
import type { GoFrameworkVisitor } from '@veoable/lang-go';
import { createFiberVisitor } from './visitor.js';

/**
 * Fiber framework plugin (Phase 5b of #474).
 *
 * Detects server-side API endpoints declared via Fiber's routing API:
 *   app.Get("/path", handler)
 *   app.Post("/path", handler)        — Title-Case (not GET)
 *   app.All("/path", handler)         → ALL
 *   app.Add("METHOD", "/path", handler)
 *
 * Group composition:
 *   api := app.Group("/api")
 *   v1  := api.Group("/v1")
 *   v1.Get("/profile", h)             →  /api/v1/profile
 *
 * Activates for projects with `gofiber/fiber` in go.mod (any version).
 */
export const FIBER_PLUGIN_ID = 'fiber' as const;

export class FiberPlugin implements FrameworkPlugin {
  readonly id = FIBER_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    if (
      hasGoModule(ctx, 'github.com/gofiber/fiber/v3')
      || hasGoModule(ctx, 'github.com/gofiber/fiber/v2')
      || hasGoModule(ctx, 'github.com/gofiber/fiber')
    ) return true;

    return ctx.files.some((f) => {
      if (!f.endsWith('.go')) return false;
      try {
        const content = fs.readFileSync(path.join(ctx.rootDir, f), 'utf-8');
        return content.includes('gofiber/fiber');
      } catch {
        return false;
      }
    });
  }

  readonly visitor: GoFrameworkVisitor = createFiberVisitor();
}
