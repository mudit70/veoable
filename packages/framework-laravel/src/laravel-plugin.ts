import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasComposerPackage } from '@adorable/plugin-api';
import type { PhpFrameworkVisitor } from '@adorable/lang-php';
import { createLaravelVisitor } from './visitor.js';

/**
 * Laravel framework plugin (#45, #55).
 *
 * Detects:
 *   1. API endpoints via Laravel Route:: facade calls
 *   2. Database interactions via Eloquent ActiveRecord pattern
 *
 * Activates when `laravel/framework` is declared in any composer.json
 * across the project tree (#203 — works on monorepos with the Laravel
 * app in a subpackage).
 */
export const LARAVEL_PLUGIN_ID = 'laravel' as const;

export class LaravelPlugin implements FrameworkPlugin {
  readonly id = LARAVEL_PLUGIN_ID;
  readonly language = 'php';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.php'))) return false;
    return hasComposerPackage(ctx, 'laravel/framework');
  }

  readonly visitor: PhpFrameworkVisitor = createLaravelVisitor();
}
