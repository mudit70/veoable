import { Node, type Expression } from 'ts-morph';
import { idFor, type ClientSideProcess } from '@veoable/schema';
import {
  type TsFrameworkVisitor,
  type TsVisitContext,
  buildEvidence,
  resolveFunctionDefinitionIdFromDecl,
} from '@veoable/lang-ts';

/**
 * SWR hook visitor (#550). Mirrors framework-react-query in shape:
 * per supported hook call, emit one `ClientSideProcess` and a
 * `TRIGGERS` edge to the resolved fetcher.
 *
 * Hook signatures (per swr.vercel.app docs):
 *
 *   useSWR(key, fetcher, options?)
 *   useSWRImmutable(key, fetcher, options?)
 *   useSWRInfinite(getKey, fetcher, options?)
 *   useSWRMutation(key, fetcher, options?)
 *   useSWRSubscription(key, subscribe, options?)
 *
 * The fetcher is ALWAYS the second positional arg. Its value may be:
 *   1. Inline arrow / function expression
 *   2. Bare identifier (import or local binding)
 *   3. PropertyAccess / CallExpression — currently unresolved
 *
 * Per-file import gate against `swr` and its subpaths so a project-
 * local `useSWR` from another library doesn't false-fire.
 */

/**
 * Hook-style call sites where the second positional arg is a fetcher
 * the SWR runtime will invoke. `useSWRSubscription` strictly takes a
 * `subscribe(key, { next })` setup function, not a fetcher — but
 * semantically it's still the user-code function the runtime will
 * invoke, so the TRIGGERS edge points at the right node for flow-
 * walker purposes.
 */
const SWR_HOOK_CALLS = new Set([
  'useSWR',
  'useSWRImmutable',
  'useSWRInfinite',
  'useSWRMutation',
  'useSWRSubscription',
]);

/**
 * Non-hook top-level imperative calls with the same `(key, fetcher)`
 * shape as the hooks. Most notably `preload(key, fetcher)`, used to
 * warm SWR's cache from outside a component. These can legitimately
 * be called at module scope, so the enclosing-function guard is
 * relaxed for them.
 */
const SWR_IMPERATIVE_CALLS = new Set([
  'preload',
]);

const SUPPORTED_IMPORT_PREFIXES = ['swr'];

export function createSwrVisitor(): TsFrameworkVisitor {
  // Per-file cache lives for the duration of a single extractFile
  // invocation (importsByFile is keyed by absolute path). The CLI
  // runs one project at a time so it's effectively reset between
  // projects.
  const importsByFile = new Map<string, boolean>();

  const fileImports = (node: Node): boolean => {
    const sf = node.getSourceFile();
    const filePath = sf.getFilePath();
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return SUPPORTED_IMPORT_PREFIXES.some((p) => spec === p || spec.startsWith(`${p}/`));
    });
    importsByFile.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',

    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!fileImports(node)) return;

      const callee = node.getExpression();
      let hookName: string | null = null;
      if (Node.isIdentifier(callee)) hookName = callee.getText();
      else if (Node.isPropertyAccessExpression(callee)) hookName = callee.getNameNode().getText();
      if (!hookName) return;
      if (!SWR_HOOK_CALLS.has(hookName) && !SWR_IMPERATIVE_CALLS.has(hookName)) return;

      // We require ctx.enclosingFunction to anchor the
      // ClientSideProcess.functionId. Hooks always satisfy this (they
      // live inside React components / custom hooks). Imperative
      // calls like `preload(key, fetcher)` MAY be called at module
      // scope — when they are, lang-ts doesn't emit any module-level
      // FunctionDefinition to attribute them to, so we currently
      // skip emission rather than produce a process with a dangling
      // functionId. This is an acknowledged miss for module-scope
      // preload; a future lang-ts change that emits a module-level
      // FunctionDefinition would let us lift this guard.
      if (!ctx.enclosingFunction) return;

      const sourceLine = node.getStartLineNumber();
      const process: ClientSideProcess = {
        nodeType: 'ClientSideProcess',
        id: idFor.clientSideProcess({
          sourceFileId: ctx.sourceFile.id,
          sourceLine,
          name: hookName,
        }),
        kind: 'lifecycle_hook',
        name: hookName,
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine,
        framework: 'swr',
        repository: ctx.sourceFile.repository,
        evidence: buildEvidence(node, ctx.sourceFile.filePath),
      };
      ctx.emitNode(process);

      // Fetcher is the second positional arg across all SWR hooks.
      const args = node.getArguments();
      if (args.length < 2) return;
      const fetcher = args[1];
      if (!fetcher) return;
      const callbackId = resolveCallbackId(fetcher as Expression, ctx);
      if (!callbackId) return;

      ctx.emitEdge({
        edgeType: 'TRIGGERS',
        from: process.id,
        to: callbackId,
      });
    },
  };
}

function resolveCallbackId(callback: Expression, ctx: TsVisitContext): string | null {
  if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
    return resolveFunctionDefinitionIdFromDecl(callback, ctx);
  }
  if (Node.isIdentifier(callback)) {
    const sym = callback.getSymbol();
    if (!sym) return null;
    let target = sym;
    try {
      const aliased = sym.getAliasedSymbol();
      if (aliased) target = aliased;
    } catch {
      // No alias — keep the original symbol.
    }
    for (const decl of target.getDeclarations()) {
      if (decl.getSourceFile().getFilePath().includes('node_modules')) continue;
      const id = resolveFunctionDefinitionIdFromDecl(decl, ctx);
      if (id) return id;
    }
    return null;
  }
  return null;
}
