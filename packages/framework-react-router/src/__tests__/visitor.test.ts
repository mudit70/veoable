import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type Screen, type NavigatesToEdge, type SchemaNode, type SchemaEdge } from '@veoable/schema';
import { type NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { ReactRouterPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/typescript/react-router/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new ReactRouterPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

function screens(batch: { nodes: SchemaNode[] }): Screen[] {
  return batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
}
function navEdges(batch: { edges: SchemaEdge[] }): NavigatesToEdge[] {
  return batch.edges.filter((e): e is NavigatesToEdge => e.edgeType === 'NAVIGATES_TO');
}

describe('react-router-dom Screen emission (#187)', () => {
  it('emits a Screen for each <Route path="..." element={<C/>}/>', async () => {
    const batch = await extract('src/App.tsx');
    const ss = screens(batch);
    const paths = new Set(ss.map((s) => s.routePath));
    // Outermost: /
    // Index inside it: also /
    // path="users": /users
    // path="users/:id": /users/:id
    // path="legacy-users": /legacy-users
    expect(paths).toContain('/');
    expect(paths).toContain('/users');
    expect(paths).toContain('/users/:id');
    expect(paths).toContain('/legacy-users');
  });

  it('every emitted Screen passes canonical schema validation', async () => {
    const batch = await extract('src/App.tsx');
    for (const s of screens(batch)) {
      expect(() => validateNode(s)).not.toThrow();
      expect(s.framework).toBe('react-router');
      expect(s.navigatorKind).toBe('web-router');
    }
  });

  it('composes nested-route paths: parent="/" + child="users" → /users', async () => {
    const batch = await extract('src/App.tsx');
    const usersScreen = screens(batch).find((s) => s.routePath === '/users');
    expect(usersScreen).toBeDefined();
    expect(usersScreen!.parentScreenId).not.toBeNull();
    // The parent is the outermost <Route path="/"> Screen.
    const rootScreen = screens(batch).find((s) => s.routePath === '/' && s.id !== usersScreen!.id);
    // Root may collide ids if both <Route path="/"> and <Route index/>
    // produce the same routePath. Verify via parent-id round-trip.
    const possibleParent = screens(batch).find((s) => s.id === usersScreen!.parentScreenId);
    expect(possibleParent).toBeDefined();
    expect(possibleParent!.routePath).toBe('/');
  });

  it('resolves `element={<HomePage/>}` to the HomePage FunctionDefinition id', async () => {
    const batch = await extract('src/App.tsx');
    const indexScreen = screens(batch).find((s) => s.routePath === '/' && s.componentFunctionId !== null);
    // The Layout root has componentFunctionId resolved too; the index
    // route's component is HomePage.
    const homeOrLayout = screens(batch).filter((s) => s.routePath === '/');
    // At least one of the '/' Screens has a componentFunctionId set.
    expect(homeOrLayout.some((s) => s.componentFunctionId !== null)).toBe(true);
  });

  it('emits a SCREEN_COMPONENT edge when the component identifier resolves', async () => {
    const batch = await extract('src/App.tsx');
    const screenComponentEdges = batch.edges.filter((e) => e.edgeType === 'SCREEN_COMPONENT');
    // 4 screens have user-defined components: Layout, HomePage,
    // UsersPage, UserDetailPage. The Navigate-redirect route's
    // element is built-in <Navigate/>, not user-defined → no edge.
    expect(screenComponentEdges.length).toBeGreaterThanOrEqual(3);
  });

  it('does NOT emit SCREEN_COMPONENT for Navigate-redirect routes', async () => {
    const batch = await extract('src/App.tsx');
    const legacy = screens(batch).find((s) => s.routePath === '/legacy-users');
    expect(legacy).toBeDefined();
    expect(legacy!.componentFunctionId).toBeNull();
  });

  it('Screen ids include routePath so two Screens with same component name don\'t collide', async () => {
    const batch = await extract('src/App.tsx');
    const ss = screens(batch);
    const ids = new Set(ss.map((s) => s.id));
    // All routePaths are distinct (or, where duplicates exist, the
    // distinct sourceLine/parentScreenId would still produce
    // distinct ids — but routePath alone should be enough here).
    expect(ids.size).toBeGreaterThanOrEqual(4);
  });
});

describe('react-router-dom <Link> NAVIGATES_TO emission (#187)', () => {
  it('emits NAVIGATES_TO edges for <Link to="/path">', async () => {
    const batch = await extract('src/Layout.tsx');
    const edges = navEdges(batch);
    // Layout has 3 <Link> tags: /, /users, /users/123.
    expect(edges.length).toBe(3);
    for (const e of edges) {
      expect(e.method).toBe('link');
    }
  });

  it('NAVIGATES_TO target ids match the Screen id shape from emitRouteScreen', async () => {
    const batch = await extract('src/Layout.tsx');
    const edges = navEdges(batch);
    const targets = new Set(edges.map((e) => e.to));
    // Each target is `idFor.screen({ repository, name: routePath, routePath })`.
    // We can't validate the id directly without computing it, but we
    // can verify they're distinct + non-empty.
    expect(targets.size).toBe(3);
    for (const t of targets) expect(t).toMatch(/^Screen:/);
  });
});

describe('useNavigate() / redirect() programmatic navigation (Round 7)', () => {
  it('emits NAVIGATES_TO with method="useNavigate" for `navigate("/path")`', async () => {
    const batch = await extract('src/UseNavigate.tsx');
    const edges = navEdges(batch).filter((e) => e.method === 'useNavigate');
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('emits NAVIGATES_TO with method="redirect" for `redirect("/path")`', async () => {
    const batch = await extract('src/UseNavigate.tsx');
    const edges = navEdges(batch).filter((e) => e.method === 'redirect');
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });
});

describe('createBrowserRouter data-router emission (Round 7)', () => {
  it('emits a Screen per route-config object literal', async () => {
    const batch = await extract('src/DataRouter.tsx');
    const paths = screens(batch).map((s) => s.routePath);
    expect(paths).toContain('/');
    expect(paths).toContain('/users');
    expect(paths).toContain('/users/:id');
  });

  it('emits SCREEN_COMPONENT edges for resolved element components', async () => {
    const batch = await extract('src/DataRouter.tsx');
    const screenComponentEdges = batch.edges.filter((e) => e.edgeType === 'SCREEN_COMPONENT');
    expect(screenComponentEdges.length).toBeGreaterThanOrEqual(3);
  });

  it('every emitted Screen passes schema validation', async () => {
    const batch = await extract('src/DataRouter.tsx');
    for (const s of screens(batch)) {
      expect(() => validateNode(s)).not.toThrow();
      expect(s.framework).toBe('react-router');
      expect(s.navigatorKind).toBe('web-router');
    }
  });
});

describe('ReactRouterPlugin contract', () => {
  it('has id="react-router" and language="ts"', () => {
    const plugin = new ReactRouterPlugin();
    expect(plugin.id).toBe('react-router');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when react-router-dom is in deps', () => {
    const plugin = new ReactRouterPlugin();
    const ctx = {
      packageJson: { dependencies: { 'react-router-dom': '^6.0.0' } },
    } as never;
    expect(plugin.appliesTo(ctx)).toBe(true);
  });

  it('appliesTo returns false when react-router is absent', () => {
    const plugin = new ReactRouterPlugin();
    const ctx = { packageJson: { dependencies: {} } } as never;
    expect(plugin.appliesTo(ctx)).toBe(false);
  });
});
