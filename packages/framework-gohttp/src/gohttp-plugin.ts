import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createGoHttpVisitor } from './visitor.js';

/**
 * Go net/http framework plugin (#23).
 *
 * Detects server-side API endpoints declared via Go's standard library:
 *   http.HandleFunc("GET /users/{id}", handler)   // Go 1.22+
 *   mux.HandleFunc("/legacy", handler)             // pre-1.22
 *   http.Handle("/path", handler)
 *   mux.Handle("/path", handler)
 *
 * Also detects Echo and Fiber patterns:
 *   e.GET("/path", handler)     // Echo
 *   app.Get("/path", handler)   // Fiber
 *
 * Always active for Go projects since net/http is a standard library
 * package (no dependency declaration needed).
 */
export const GOHTTP_PLUGIN_ID = 'gohttp' as const;

export class GoHttpPlugin implements FrameworkPlugin {
  readonly id = GOHTTP_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    // net/http is standard library — always active for Go projects
    return ctx.files.some((f) => f.endsWith('.go'));
  }

  readonly visitor: GoFrameworkVisitor = createGoHttpVisitor();
}
