import type { FrameworkPlugin, ProjectContext } from '@adorable/plugin-api';
import type { TsFrameworkVisitor } from '@adorable/lang-ts';
import { createReactVisitor } from './visitor.js';

/**
 * React framework plugin (#56).
 *
 * Detects client-side processes in TypeScript / TSX source: JSX
 * event-handler attributes and React lifecycle hook calls
 * (`useEffect`, `useLayoutEffect`). Emits canonical
 * `ClientSideProcess` nodes attributed to the enclosing function
 * (typically a React component).
 *
 * Unlike the Prisma plugin, React has no project-level prelude —
 * there is no schema file to parse, and the visitor is stateless.
 * The same `ReactPlugin` instance can analyze any number of projects
 * without resetting.
 */
export const REACT_PLUGIN_ID = 'react' as const;

export class ReactPlugin implements FrameworkPlugin {
  readonly id = REACT_PLUGIN_ID;
  readonly language = 'ts';

  /**
   * Returns true when the current project looks like a React project:
   * either `react` is listed in dependencies / devDependencies /
   * peerDependencies, or any file in `ctx.files` has a `.tsx` / `.jsx`
   * extension.
   */
  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    if ('react' in deps) return true;
    return ctx.files.some((f) => f.endsWith('.tsx') || f.endsWith('.jsx'));
  }

  /**
   * Stateless visitor — always the same instance. Unlike the Prisma
   * plugin, React has no per-project state, so we construct the
   * visitor once in the constructor and return the same reference on
   * every access.
   */
  readonly visitor: TsFrameworkVisitor = createReactVisitor();
}
