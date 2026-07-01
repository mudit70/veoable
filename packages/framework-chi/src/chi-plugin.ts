import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createChiVisitor } from './visitor.js';

/**
 * chi router framework plugin — Go's most popular routing library
 * after the net/http stdlib.
 *
 * Detected shapes:
 *
 *   r := chi.NewRouter()
 *   r.Get("/users", listUsers)
 *   r.Post("/users", createUser)
 *   r.Put("/users/{id}", updateUser)
 *   r.Delete("/users/{id}", deleteUser)
 *   r.Patch / r.Head / r.Options
 *
 *   r.Method("CUSTOM", "/path", handler)
 *   r.MethodFunc("PROPFIND", "/path", handlerFn)
 *
 * Route() prefix composition (`r.Route("/api", func(r chi.Router) {
 * ... })` so the inner `r.Get("/health")` resolves to `/api/health`)
 * is a known v1 limitation — inner routes emit with the path as
 * written. Many real chi codebases register top-level routes
 * directly; mid-complexity codebases with nested Route() see
 * unprefixed patterns until v2.
 *
 * Activation: any `github.com/go-chi/chi` in any go.mod.
 */
export const CHI_PLUGIN_ID = 'chi' as const;

export class ChiPlugin implements FrameworkPlugin {
  readonly id = CHI_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    return hasGoModule(ctx, 'github.com/go-chi/chi');
  }

  readonly visitor: GoFrameworkVisitor = createChiVisitor();
}
