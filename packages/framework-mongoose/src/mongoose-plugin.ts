import type { FrameworkPlugin, NodeBatch, ProjectContext } from '@veoable/plugin-api';
import { idFor, type SchemaNode } from '@veoable/schema';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createMongooseVisitor } from './visitor.js';
import { scanMongooseSchemas } from './schema-scanner.js';

export const MONGOOSE_PLUGIN_ID = 'mongoose' as const;

export class MongoosePlugin implements FrameworkPlugin {
  readonly id = MONGOOSE_PLUGIN_ID;
  readonly language = 'ts';

  private _systemId: string | null = null;
  private _classToCollection: Map<string, string> | null = null;
  private _visitor: TsFrameworkVisitor | null = null;

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    return 'mongoose' in deps || '@nestjs/mongoose' in deps;
  }

  onProjectLoaded(ctx: ProjectContext): NodeBatch {
    // Synthetic MongoDB system. One per project.
    const system = {
      nodeType: 'DatabaseSystem' as const,
      id: idFor.databaseSystem({ kind: 'mongodb', name: 'mongodb' }),
      kind: 'mongodb' as const,
      name: 'mongodb',
      connectionSource: null,
    };
    this._systemId = system.id;
    this._visitor = null;

    // Scan TS files for `@Schema()` classes and `mongoose.model()` calls.
    // Emit a DatabaseTable per detected schema; build a class→collection
    // map for the visitor to use when resolving CRUD-call receivers (#178).
    const { tables, classToCollection } = scanMongooseSchemas(
      ctx.rootDir,
      ctx.files,
      system.id,
    );
    this._classToCollection = classToCollection;

    return {
      nodes: [system as SchemaNode, ...(tables as SchemaNode[])],
      edges: [],
    };
  }

  get visitor(): TsFrameworkVisitor {
    if (this._visitor) return this._visitor;
    if (!this._systemId) {
      // No-op visitor if onProjectLoaded wasn't called.
      return { language: 'ts', onNode() {} };
    }
    this._visitor = createMongooseVisitor(this._systemId, this._classToCollection ?? new Map());
    return this._visitor;
  }
}
