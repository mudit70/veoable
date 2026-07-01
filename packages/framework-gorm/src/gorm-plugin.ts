import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import { hasGoModule } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from '@adorable/lang-go';
import { createGormVisitor } from './visitor.js';

/**
 * GORM framework plugin (#52).
 *
 * Detects database interactions via GORM method chains:
 *   db.Find(&users), db.First(&user, id), db.Create(&user),
 *   db.Delete(&user, id), db.Where(...).Find(...), db.Raw(...).Scan(...)
 *
 * Activates when go.mod contains gorm.io/gorm.
 */
export const GORM_PLUGIN_ID = 'gorm' as const;

export class GormPlugin implements FrameworkPlugin {
  readonly id = GORM_PLUGIN_ID;
  readonly language = 'go';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.go'))) return false;
    return hasGoModule(ctx, 'gorm.io/gorm');
  }

  readonly visitor: GoFrameworkVisitor = createGormVisitor();
}
