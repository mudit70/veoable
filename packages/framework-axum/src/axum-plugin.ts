import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createAxumVisitor } from './visitor.js';
import { buildAxumHandlerMap, type HandlerMap } from './handler-resolver.js';

/**
 * Axum framework plugin (#25).
 *
 * Detects API endpoints declared via Axum's builder pattern:
 *   Router::new().route("/path", get(handler).post(handler))
 *
 * Axum uses no procedural macros — all routing is pure function composition.
 * Activates when `axum` is a Cargo dependency in any subpackage of the
 * project tree (#203).
 *
 * Project-load pass: scans every `.rs` file in `rootDir` to build a
 * cross-file name → declaration map. The visitor uses it to resolve
 * `get(handler_fn)` / `post(handler_fn)` arg expressions to the
 * `FunctionDefinition.id` lang-rust emits, so the flow walker can
 * BFS into the handler body from a stitched endpoint.
 */
export const AXUM_PLUGIN_ID = 'axum' as const;

export class AxumPlugin implements FrameworkPlugin {
  readonly id = AXUM_PLUGIN_ID;
  readonly language = 'rust';

  private _visitor: RustFrameworkVisitor | null = null;
  private _handlerMap: HandlerMap | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'axum');
  }

  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    this._handlerMap = buildAxumHandlerMap(ctx.rootDir);
    this._visitor = createAxumVisitor(this._handlerMap);
    return { nodes: [], edges: [] };
  }

  get visitor(): RustFrameworkVisitor {
    if (!this._visitor) {
      this._visitor = createAxumVisitor(this._handlerMap ?? undefined);
    }
    return this._visitor;
  }
}
