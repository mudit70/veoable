import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createAngularVisitor } from './visitor.js';

/**
 * Angular framework plugin (#58).
 *
 * Detects client-side processes in Angular TypeScript source:
 *   - Lifecycle hooks (ngOnInit, ngOnDestroy, ngOnChanges, etc.)
 *   - RxJS reactive patterns (subscribe, pipe+switchMap)
 *   - NgRx effects (createEffect)
 *
 * Note: Angular template event bindings `(click)="handler()"` live in
 * separate `.html` files and are not detected by this AST-based visitor.
 * Template parsing is deferred to a future pass.
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const ANGULAR_PLUGIN_ID = 'angular' as const;

export class AngularPlugin implements FrameworkPlugin {
  readonly id = ANGULAR_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return '@angular/core' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createAngularVisitor();
}
