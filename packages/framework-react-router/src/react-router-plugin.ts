import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createReactRouterVisitor } from './visitor.js';

/**
 * react-router-dom framework plugin (#187).
 *
 * Detects browser-side routing in React SPAs:
 *   - <Route path="..." element={<Component/>} /> declarations,
 *     including nested-route composition (parent path + child path).
 *   - <Link to="..." /> and <NavLink to="..." /> → NAVIGATES_TO edges.
 *
 * Activates when react-router or react-router-dom is in dependencies.
 *
 * Out of scope (subsequent PRs):
 *   - createBrowserRouter / createMemoryRouter / createHashRouter
 *     route-config arrays.
 *   - useNavigate() and redirect() call detection.
 *   - File-routed frameworks (Next.js / Remix / SvelteKit) — those
 *     have their own visitors and route conventions.
 */
export const REACT_ROUTER_PLUGIN_ID = 'react-router' as const;

export class ReactRouterPlugin implements FrameworkPlugin {
  readonly id = REACT_ROUTER_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return 'react-router-dom' in deps || 'react-router' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createReactRouterVisitor();
}
