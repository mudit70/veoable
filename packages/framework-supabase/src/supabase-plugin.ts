import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { idFor, type DatabaseSystem } from '@veoable/schema';
import { createSupabaseVisitor } from './visitor.js';
import { extractEdgeFunctions } from './edge-functions.js';

export const SUPABASE_PLUGIN_ID = 'supabase' as const;

export class SupabasePlugin implements FrameworkPlugin {
  readonly id = SUPABASE_PLUGIN_ID;
  readonly language = 'ts';

  private _visitor: TsFrameworkVisitor | null = null;
  private _systemId: string | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    if ('@supabase/supabase-js' in deps) return true;
    // #190 — also activate when the project has a `supabase/functions/`
    // directory even without the SDK in deps. Edge Function repos
    // commonly don't list the SDK in package.json (they import from
    // Deno's URL imports inside the function body).
    const fnDir = path.join(ctx.rootDir, 'supabase', 'functions');
    return fs.existsSync(fnDir) && fs.statSync(fnDir).isDirectory();
  }

  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    // Emit a DatabaseSystem node for Supabase (PostgreSQL under the hood).
    const system: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'supabase' }),
      kind: 'postgres',
      name: 'supabase',
      connectionSource: 'env("SUPABASE_URL")',
    };
    this._systemId = system.id;
    this._visitor = createSupabaseVisitor(system.id);

    // #190 — discover Supabase Edge Functions and emit APIEndpoints
    // for each. Combined into the same NodeBatch.
    const repository = path.basename(ctx.rootDir);
    const edgeBatch = extractEdgeFunctions(ctx.rootDir, repository);

    return {
      nodes: [system, ...edgeBatch.nodes],
      edges: edgeBatch.edges,
    };
  }

  get visitor(): TsFrameworkVisitor {
    if (!this._visitor) {
      // Fallback if onProjectLoaded wasn't called.
      const systemId = idFor.databaseSystem({ kind: 'postgres', name: 'supabase' });
      this._visitor = createSupabaseVisitor(systemId);
    }
    return this._visitor;
  }
}
