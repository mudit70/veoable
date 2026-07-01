import type { Node } from 'ts-morph';
import type { TsVisitContext } from './framework-visitor.js';
import { functionDefinitionIdFor } from './function-id.js';

/**
 * #263 — Shared cross-file FunctionDefinition.id resolver.
 *
 * Three framework-state-mgmt branches (Saga handler, RTK thunk payload
 * creator, TanStack/RTK Query function arg) plus the React-Native
 * JSX-handler branch each had a near-identical "given a declaration,
 * resolve to the FunctionDefinition.id lang-ts will emit" routine,
 * each with the same same-file-only shortcut. CLAUDE.md flags this
 * exact duplication as a refactor smell.
 *
 * This helper centralizes the resolution by delegating to the existing
 * `functionDefinitionIdFor` (`function-id.ts`), which is also what the
 * structural walker and call resolver use — single source of truth.
 *
 * Supports CROSS-FILE resolution: when the resolved declaration lives
 * in a different source file from the visitor's current file,
 * `functionDefinitionIdFor` computes the target file's sourceFileId
 * from `ctx.repository` + repo-relative POSIX path. Saga / thunk /
 * query / RN-handler edges now correctly point at handlers imported
 * from another module.
 *
 * Returns null when:
 *   - The declaration shape isn't function-like.
 *   - The declaration name can't be derived (anonymous expression).
 *   - The declaration lives outside the project root (external module
 *     not emitted as a FunctionDefinition).
 */
export function resolveFunctionDefinitionIdFromDecl(
  decl: Node,
  ctx: TsVisitContext,
): string | null {
  return functionDefinitionIdFor(
    { rootDir: ctx.rootDir, repository: ctx.repository },
    decl,
  );
}
