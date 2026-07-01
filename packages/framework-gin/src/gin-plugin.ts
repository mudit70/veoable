import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createGinVisitor } from './visitor.js';
import { buildGinHandlerMap, type HandlerMap } from './handler-resolver.js';

/**
 * Gin framework plugin (#22).
 *
 * Detects server-side API endpoints declared via the Gin routing API:
 *   router.GET("/path", handler)
 *   router.POST("/path", handler)
 *   router.Any("/path", handler)
 *   router.Handle("METHOD", "/path", handler)
 *
 * Only activates for projects with `gin-gonic/gin` in go.mod or
 * go.sum (m2 fix). Per-file import checks are the secondary guard.
 */
export const GIN_PLUGIN_ID = 'gin' as const;

export class GinPlugin implements FrameworkPlugin {
  readonly id = GIN_PLUGIN_ID;
  readonly language = 'go';

  private _visitor: GoFrameworkVisitor | null = null;
  private _handlerMap: HandlerMap | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;

    // Primary: check any go.mod under the project tree (#203 — works
    // on monorepos where Gin lives in a subpackage like
    // services/auth/go.mod).
    if (hasGoModule(ctx, 'github.com/gin-gonic/gin')) return true;

    // Fallback: scan source files for the import path. Useful for
    // test fixtures that lack a go.mod but include `import "gin..."`.
    return ctx.files.some((f) => {
      if (!f.endsWith('.go')) return false;
      try {
        const content = fs.readFileSync(path.join(ctx.rootDir, f), 'utf-8');
        return content.includes('gin-gonic/gin');
      } catch { return false; }
    });
  }

  /**
   * Project-load pass: walk every `.go` file once and build a
   * name → declaration map so the visitor can resolve
   * `r.GET("/x", v.List)`-style handler references to the
   * `Vehicles.List` FunctionDefinition id lang-go emits — even when
   * `Vehicles` and the method live in a different file from the
   * route registration.
   */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    this._handlerMap = buildGinHandlerMap(ctx.rootDir);
    this._visitor = createGinVisitor(this._handlerMap);
    return { nodes: [], edges: [] };
  }

  get visitor(): GoFrameworkVisitor {
    if (!this._visitor) {
      this._visitor = createGinVisitor(this._handlerMap ?? undefined);
    }
    return this._visitor;
  }
}
