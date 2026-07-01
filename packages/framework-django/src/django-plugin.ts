import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { hasPythonPackage } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from '@veoable/lang-py';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createDjangoVisitor } from './visitor.js';
import { buildDjangoUrlMap, type DjangoUrlMap } from './urls-resolver.js';

export const DJANGO_PLUGIN_ID = 'django' as const;

export class DjangoPlugin implements FrameworkPlugin {
  readonly id = DJANGO_PLUGIN_ID;
  readonly language = 'py';

  private _visitor: PyFrameworkVisitor | null = null;
  private _urlMap: DjangoUrlMap | null = null;

  /**
   * Activates when `django` or `djangorestframework` is declared in
   * any Python manifest, OR when a `manage.py` file is present
   * (Django's filesystem convention). Monorepo-aware via #203.
   */
  appliesTo(ctx: ProjectContext): boolean {
    if (hasPythonPackage(ctx, 'django')) return true;
    if (hasPythonPackage(ctx, 'djangorestframework')) return true;
    // Manage.py convention — fallback when no explicit dep manifest is found.
    return ctx.files.some((f) => f === 'manage.py' || f.endsWith('/manage.py'));
  }

  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'other', name: 'django' }),
      kind: 'other',
      name: 'django',
      connectionSource: 'settings.DATABASES',
    };
    // #221 — build the cross-file urls.py prefix map at project-load.
    this._urlMap = buildDjangoUrlMap(ctx.rootDir);
    this._visitor = createDjangoVisitor(system.id, this._urlMap);
    return { nodes: [system], edges: [] };
  }

  get visitor(): PyFrameworkVisitor {
    if (!this._visitor) {
      const systemId = idFor.databaseSystem({ kind: 'other', name: 'django' });
      this._visitor = createDjangoVisitor(systemId, this._urlMap ?? undefined);
    }
    return this._visitor;
  }
}
