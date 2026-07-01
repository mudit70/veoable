import { Node } from 'ts-morph';
import { idFor, type DatabaseOperation } from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@veoable/lang-ts';
import { defaultCollection } from './schema-scanner.js';

/**
 * Mongoose framework visitor (#48, #127).
 *
 * Detects Mongoose model CRUD operations:
 *   Model.find(), Model.findOne(), Model.findById()
 *   Model.create(), new Model(data).save()
 *   Model.updateOne(), Model.findByIdAndUpdate()
 *   Model.deleteOne(), Model.findByIdAndDelete()
 *   Model.aggregate()
 */

const READ_METHODS: ReadonlySet<string> = new Set([
  'find', 'findOne', 'findById',
  'countDocuments', 'count',
  'distinct', 'aggregate', 'estimatedDocumentCount',
]);

const WRITE_METHODS: ReadonlySet<string> = new Set([
  'create', 'insertMany', 'save',
]);

const UPDATE_METHODS: ReadonlySet<string> = new Set([
  'updateOne', 'updateMany', 'findOneAndUpdate',
  'findByIdAndUpdate', 'replaceOne',
]);

const DELETE_METHODS: ReadonlySet<string> = new Set([
  'deleteOne', 'deleteMany', 'findOneAndDelete',
  'findByIdAndDelete', 'findOneAndRemove', 'remove',
]);

export function createMongooseVisitor(
  systemId: string,
  /**
   * Class-name → collection-name map populated by `scanMongooseSchemas`
   * during `onProjectLoaded`. Used to resolve a CRUD-call receiver
   * (`this.userModel`) to the correct collection — which may differ
   * from the default pluralization when the schema specifies an
   * explicit `@Schema({ collection: '...' })` override (e.g.,
   * `FollowUser` → `follow_users`).
   */
  classToCollection: ReadonlyMap<string, string>,
): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!ctx.enclosingFunction) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;

      const methodName = callee.getNameNode().getText();

      // Determine operation type.
      let operation: DatabaseOperation | null = null;
      if (READ_METHODS.has(methodName)) operation = 'read';
      else if (WRITE_METHODS.has(methodName)) operation = 'write';
      else if (UPDATE_METHODS.has(methodName)) operation = 'update';
      else if (DELETE_METHODS.has(methodName)) operation = 'delete';
      if (!operation) return;

      // Check if receiver looks like a Mongoose model.
      const receiver = callee.getExpression();
      const receiverText = receiver.getText();

      // Heuristics: model name patterns
      // 1. this.modelName (NestJS injection pattern)
      // 2. ModelName.find() (direct model usage)
      // 3. this.userModel.find() (common NestJS pattern)
      const isModel =
        receiverText.includes('Model') ||
        receiverText.includes('model') ||
        /^this\.\w+Model/.test(receiverText) ||
        /^[A-Z][a-zA-Z]+$/.test(receiverText); // PascalCase receiver

      if (!isModel) return;

      // Derive the schema class name from the receiver text:
      //   this.userModel  → User
      //   userModel       → User
      //   User            → User
      //   this.users      → Users  (no Model suffix; handled by the
      //                              un-pluralization fallback below)
      let className = receiverText
        .replace(/^this\./, '')
        .replace(/Model$/i, '')
        .replace(/^_/, '');
      if (className.length === 0) className = receiverText;
      className = className.charAt(0).toUpperCase() + className.slice(1);

      // Resolve to the actual collection name. Try in order:
      //   1. classToCollection[className] — exact map hit. Built from
      //      `@Schema({ collection: '...' })` declarations during
      //      onProjectLoaded; this is the source of truth.
      //   2. classToCollection[singularized className] — falls back when
      //      the receiver was already pluralized (`this.users` → `Users`
      //      isn't in the map but `User` is).
      //   3. defaultCollection(className) — Mongoose's default
      //      pluralization. Matches what the scanner emitted for any
      //      schema without an explicit collection override.
      let collectionName = classToCollection.get(className);
      if (!collectionName && className.endsWith('s') && className.length > 1) {
        collectionName = classToCollection.get(className.slice(0, -1));
      }
      if (!collectionName) collectionName = defaultCollection(className);

      const targetTableId = idFor.databaseTable({
        systemId,
        schema: null,
        name: collectionName,
      });

      const interactionId = idFor.databaseInteraction({
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        targetTableId,
      });

      ctx.emitNode({
        nodeType: 'DatabaseInteraction',
        id: interactionId,
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'mongoose',
        rawQuery: null,
        confidence: 'inferred',
        evidence: buildEvidence(node, ctx.sourceFile.filePath, 'heuristic'),
      });

      if (operation === 'read') {
        ctx.emitEdge({
          edgeType: 'READS', from: interactionId, to: targetTableId,
          columns: null, filters: null,
        });
      } else {
        const kind = operation === 'write' ? 'insert' as const
          : operation === 'update' ? 'update' as const
          : 'delete' as const;
        ctx.emitEdge({
          edgeType: 'WRITES', from: interactionId, to: targetTableId,
          columns: null, kind,
        });
      }

      ctx.emitEdge({
        edgeType: 'PERFORMED_BY', from: interactionId, to: ctx.enclosingFunction.id,
        sourceLine: node.getStartLineNumber(),
      });
    },
  };
}
