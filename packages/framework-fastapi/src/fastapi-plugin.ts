import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { createFastapiVisitor } from './visitor.js';
import { buildIncludeRouterMap, type IncludeRouterMap } from './include-resolver.js';

export const FASTAPI_PLUGIN_ID = 'fastapi' as const;

export class FastapiPlugin implements FrameworkPlugin {
  readonly id = FASTAPI_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;
  private _includeMap: IncludeRouterMap | null = null;

  /**
   * Activates when `fastapi` is declared in any Python manifest under
   * the project tree (#203). Works on flat repos AND monorepos where
   * FastAPI lives in a subpackage like `apps/api/requirements.txt`.
   */
  appliesTo(ctx: ProjectContext): boolean {
    return hasPythonPackage(ctx, 'fastapi');
  }

  /**
   * Project-load pass: scans every `.py` file for cross-file
   * `include_router(prefix=…)` chains and composes the full route
   * prefix for each router declaration. Threads the resulting map
   * into the visitor.
   */
  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    this._includeMap = buildIncludeRouterMap(ctx.rootDir);
    this._visitor = createFastapiVisitor(this._includeMap);
    return { nodes: [], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      this._visitor = createFastapiVisitor(this._includeMap ?? undefined);
    }
    return this._visitor;
  }
}
