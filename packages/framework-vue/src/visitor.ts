import { Node } from 'ts-morph';
import { idFor, type ClientSideProcess } from '@adorable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@adorable/lang-ts';

/**
 * Vue.js framework visitor (#57).
 *
 * Detects Vue composition API patterns in <script setup> blocks:
 *
 *   onMounted(() => { ... })     → lifecycle_hook process
 *   onUpdated(() => { ... })     → lifecycle_hook process
 *   watch(source, () => { ... }) → lifecycle_hook process
 *
 * Note: @click, v-on directives in <template> are NOT detectable from
 * the TypeScript AST because they're in the HTML template. The script
 * setup functions that handle events (handleClick, handleSubmit) are
 * detected as regular FunctionDefinitions by lang-ts. The Vue visitor
 * focuses on composition API lifecycle hooks and watchers.
 *
 * Options API patterns (data(), methods: {}, mounted() {}) are also
 * detected when the file uses defineComponent().
 */

const LIFECYCLE_HOOKS = new Set([
  'onMounted', 'onUpdated', 'onUnmounted', 'onBeforeMount',
  'onBeforeUpdate', 'onBeforeUnmount', 'onActivated', 'onDeactivated',
  'onErrorCaptured',
]);

const WATCHERS = new Set(['watch', 'watchEffect', 'watchPostEffect', 'watchSyncEffect']);

export function createVueVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',

    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      const callee = node.getExpression();
      if (!Node.isIdentifier(callee)) return;

      const fnName = callee.getText();

      // Lifecycle hooks: onMounted(() => { ... })
      if (LIFECYCLE_HOOKS.has(fnName)) {
        const componentName = inferComponentName(ctx.sourceFile.filePath);
        const process: ClientSideProcess = {
          nodeType: 'ClientSideProcess',
          id: idFor.clientSideProcess({
            sourceFileId: ctx.sourceFile.id,
            sourceLine: node.getStartLineNumber(),
            name: fnName,
          }),
          kind: 'lifecycle_hook',
          name: fnName,
          functionId: ctx.enclosingFunction?.id ?? idFor.functionDefinition({
            sourceFileId: ctx.sourceFile.id,
            name: componentName,
            sourceLine: 1,
          }),
          sourceFileId: ctx.sourceFile.id,
          sourceLine: node.getStartLineNumber(),
          framework: 'vue',
          repository: ctx.sourceFile.repository,
          evidence: buildEvidence(node, ctx.sourceFile.filePath),
        };
        ctx.emitNode(process);

        // Emit TRIGGERS edge to the callback if it's an inline function.
        const args = node.getArguments();
        if (args.length > 0) {
          const callback = args[0];
          if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
            const callbackId = idFor.functionDefinition({
              sourceFileId: ctx.sourceFile.id,
              name: `${componentName}.${fnName}$callback`,
              sourceLine: callback.getStartLineNumber(),
            });
            ctx.emitEdge({
              edgeType: 'TRIGGERS',
              from: process.id,
              to: callbackId,
            });
          }
        }
        return;
      }

      // Watchers: watch(source, () => { ... })
      // m1 fix: use 'event_handler' kind (watchers respond to state changes)
      if (WATCHERS.has(fnName)) {
        const componentName = inferComponentName(ctx.sourceFile.filePath);
        const process: ClientSideProcess = {
          nodeType: 'ClientSideProcess',
          id: idFor.clientSideProcess({
            sourceFileId: ctx.sourceFile.id,
            sourceLine: node.getStartLineNumber(),
            name: fnName,
          }),
          kind: 'event_handler',
          name: fnName,
          functionId: ctx.enclosingFunction?.id ?? idFor.functionDefinition({
            sourceFileId: ctx.sourceFile.id,
            name: componentName,
            sourceLine: 1,
          }),
          sourceFileId: ctx.sourceFile.id,
          sourceLine: node.getStartLineNumber(),
          framework: 'vue',
          repository: ctx.sourceFile.repository,
          evidence: buildEvidence(node, ctx.sourceFile.filePath),
        };
        ctx.emitNode(process);

        // m2 fix: emit TRIGGERS edge to the callback (second arg for watch, first for watchEffect).
        const args = node.getArguments();
        const callbackIdx = fnName === 'watch' ? 1 : 0;
        if (args.length > callbackIdx) {
          const callback = args[callbackIdx];
          if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
            const callbackId = idFor.functionDefinition({
              sourceFileId: ctx.sourceFile.id,
              name: `${componentName}.${fnName}$callback`,
              sourceLine: callback.getStartLineNumber(),
            });
            ctx.emitEdge({
              edgeType: 'TRIGGERS',
              from: process.id,
              to: callbackId,
            });
          }
        }
        return;
      }
    },
  };
}

/** Infer Vue component name from file path: ContactList.vue → ContactList */
function inferComponentName(filePath: string): string {
  const match = filePath.match(/([^/\\]+?)\.vue$/);
  return match?.[1] ?? 'Component';
}
