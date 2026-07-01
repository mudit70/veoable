import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type ClientSideProcess, type Screen, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { ReactNativePlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/react-native/basic');
const NAV_FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/react-native/navigation');

async function extract(file: string, root = FIXTURE_ROOT): Promise<NodeBatch> {
  const rn = new ReactNativePlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(rn.visitor);
  const handle = await ts.loadProject({ rootDir: root });
  return ts.extractFile(handle, file);
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

function screens(batch: { nodes: SchemaNode[] }): Screen[] {
  return batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
}

describe('react-native event handler detection', () => {
  it('detects onPress as event_handler', async () => {
    const batch = await extract('src/Screen.tsx');
    const procs = processes(batch);
    const press = procs.find((p) => p.name === 'onPress');
    expect(press).toBeDefined();
    expect(press!.kind).toBe('event_handler');
    expect(press!.framework).toBe('react-native');
  });

  it('detects onLongPress as event_handler', async () => {
    const batch = await extract('src/Screen.tsx');
    const procs = processes(batch);
    const longPress = procs.find((p) => p.name === 'onLongPress');
    expect(longPress).toBeDefined();
    expect(longPress!.kind).toBe('event_handler');
  });

  // #266 — TRIGGERS edges from event-handler processes
  it('emits TRIGGERS edge from onPress process to a same-file Identifier handler', async () => {
    const batch = await extract('src/Screen.tsx');
    const procs = processes(batch);
    const press = procs.find((p) => p.name === 'onPress' && p.sourceLine === 21);
    expect(press).toBeDefined();
    const triggers = batch.edges.filter(
      (e) => e.edgeType === 'TRIGGERS' && e.from === press!.id,
    );
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    // Edge points at the same-file `handlePress` arrow.
    const handlePressFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && (n as { name: string }).name === 'handlePress',
    );
    expect(handlePressFn).toBeDefined();
    expect(triggers.some((e) => e.to === handlePressFn!.id)).toBe(true);
  });

  it('emits TRIGGERS edge from onPress process to a same-file async Identifier handler', async () => {
    const batch = await extract('src/Screen.tsx');
    const procs = processes(batch);
    const press = procs.find((p) => p.name === 'onPress' && p.sourceLine === 24);
    expect(press).toBeDefined();
    const triggers = batch.edges.filter(
      (e) => e.edgeType === 'TRIGGERS' && e.from === press!.id,
    );
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    const handleDeleteFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && (n as { name: string }).name === 'handleDelete',
    );
    expect(handleDeleteFn).toBeDefined();
    expect(triggers.some((e) => e.to === handleDeleteFn!.id)).toBe(true);
  });

  it('boolean-shorthand JSX attribute (no expression) does not emit a TRIGGERS edge', async () => {
    // Negative case: the visitor still emits a process node for any
    // recognized event-handler attribute, but with no expression value
    // resolveJsxHandlerFunctionId returns null and no TRIGGERS edge
    // fires. Tests this implicitly via assertion: every TRIGGERS edge
    // we emit must have a `to` that resolves to a real node.
    const batch = await extract('src/Screen.tsx');
    const triggers = batch.edges.filter((e) => e.edgeType === 'TRIGGERS');
    const fnIds = new Set(
      batch.nodes
        .filter((n) => n.nodeType === 'FunctionDefinition')
        .map((n) => n.id),
    );
    for (const e of triggers) {
      expect(fnIds.has(e.to)).toBe(true);
    }
  });

  it('emits TRIGGERS edge from onLongPress process to its inline arrow callback', async () => {
    // Inline arrows at JsxExpression position are emitted by lang-ts
    // Pattern 1 with name `<enclosingFn>.<attrName>$callback`. The
    // visitor computes the same id and emits the edge.
    const batch = await extract('src/Screen.tsx');
    const procs = processes(batch);
    const longPress = procs.find((p) => p.name === 'onLongPress');
    expect(longPress).toBeDefined();
    const triggers = batch.edges.filter(
      (e) => e.edgeType === 'TRIGGERS' && e.from === longPress!.id,
    );
    expect(triggers.length).toBe(1);
    const inlineCallback = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition'
        && (n as { name: string }).name === 'Screen.onLongPress$callback',
    );
    expect(inlineCallback).toBeDefined();
    expect(triggers[0].to).toBe(inlineCallback!.id);
  });

  it('detects useEffect as lifecycle_hook', async () => {
    const batch = await extract('src/Screen.tsx');
    const procs = processes(batch);
    const effect = procs.find((p) => p.name === 'useEffect');
    expect(effect).toBeDefined();
    expect(effect!.kind).toBe('lifecycle_hook');
    expect(effect!.framework).toBe('react-native');
  });

  it('every process passes schema validation', async () => {
    const batch = await extract('src/Screen.tsx');
    for (const p of processes(batch)) {
      expect(() => validateNode(p)).not.toThrow();
    }
  });
});

describe('navigation detection', () => {
  it('detects navigation.navigate call as NAVIGATES_TO edge', async () => {
    const batch = await extract('src/Screen.tsx');
    const navEdges = batch.edges.filter((e) => e.edgeType === 'NAVIGATES_TO');
    expect(navEdges.length).toBeGreaterThanOrEqual(1);
  });
});

describe('ReactNativePlugin contract', () => {
  it('has id="react-native" and language="ts"', () => {
    const plugin = new ReactNativePlugin();
    expect(plugin.id).toBe('react-native');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true for react-native projects', () => {
    const plugin = new ReactNativePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { 'react-native': '^0.74.0', react: '^18.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true for expo projects', () => {
    const plugin = new ReactNativePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { expo: '~51.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for web-only React', () => {
    const plugin = new ReactNativePlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { react: '^18.0.0' } },
        files: [],
      })
    ).toBe(false);
  });
});

describe('cross-file component resolution (Phase 4)', () => {
  it('detects Stack.Screen declarations in navigator file', async () => {
    const batch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const screenNodes = screens(batch);
    expect(screenNodes.length).toBeGreaterThanOrEqual(3);
    const names = screenNodes.map((s) => s.name);
    expect(names).toContain('Login');
    expect(names).toContain('Home');
    expect(names).toContain('Detail');
  });

  it('resolves default-imported component to FunctionDefinition ID', async () => {
    const batch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const homeScreen = screens(batch).find((s) => s.name === 'Home');
    expect(homeScreen).toBeDefined();
    // HomeScreen is a default export — componentFunctionId should be resolved
    expect(homeScreen!.componentFunctionId).not.toBeNull();
    expect(homeScreen!.componentFunctionId).toContain('FunctionDefinition:');
  });

  it('resolves named-imported component to FunctionDefinition ID', async () => {
    const batch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const loginScreen = screens(batch).find((s) => s.name === 'Login');
    expect(loginScreen).toBeDefined();
    // LoginScreen is a named export — componentFunctionId should be resolved
    expect(loginScreen!.componentFunctionId).not.toBeNull();
    expect(loginScreen!.componentFunctionId).toContain('FunctionDefinition:');
  });

  it('emits SCREEN_COMPONENT edges for resolved components', async () => {
    const batch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const screenCompEdges = batch.edges.filter((e) => e.edgeType === 'SCREEN_COMPONENT');
    // Should have edges for resolved components (Home, Detail, Login, Player)
    expect(screenCompEdges.length).toBeGreaterThanOrEqual(3);
    // No unresolved edges
    for (const edge of screenCompEdges) {
      expect(edge.to).not.toContain('unresolved');
      expect(edge.to).toContain('FunctionDefinition:');
    }
  });

  // #267 — class-component screen binding
  it('binds <Stack.Screen component={ClassComponent}/> to the class render method', async () => {
    const batch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const playerScreen = screens(batch).find((s) => s.name === 'Player');
    expect(playerScreen).toBeDefined();
    // Pre-fix this was null because unwrapToFunction rejected the
    // ClassDeclaration. After #267 the visitor unwraps to render.
    expect(playerScreen!.componentFunctionId).not.toBeNull();
    expect(playerScreen!.componentFunctionId).toContain('FunctionDefinition:');
  });

  // #289 — HOC-wrapped class component
  it('binds <Stack.Screen component={HOCWrapped}/> through connect()() to ClassName.render', async () => {
    // export default connect(mapState, mapDispatch)(HOCWrappedScreen)
    // — the canonical react-redux pattern. Pre-fix this produced a
    // null componentFunctionId because the export is a CallExpression
    // value, not the class.
    const navBatch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const hocScreen = screens(navBatch).find((s) => s.name === 'HOCWrapped');
    expect(hocScreen).toBeDefined();
    expect(hocScreen!.componentFunctionId).not.toBeNull();
    expect(hocScreen!.componentFunctionId).toContain('FunctionDefinition:');

    // Cross-check: the id matches what lang-ts emits for
    // HOCWrappedScreen.render in the screen's own file.
    const screenBatch = await extract('src/screens/HOCWrappedScreen.tsx', NAV_FIXTURE_ROOT);
    const renderFn = screenBatch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition'
        && (n as { name: string }).name === 'HOCWrappedScreen.render',
    );
    expect(renderFn).toBeDefined();
    expect(hocScreen!.componentFunctionId).toBe(renderFn!.id);
  });

  it('binds <Stack.Screen component={HOCWrappedFn}/> through connect()() to the function (not a render method)', async () => {
    // HOC wrapping a function component — should resolve to the
    // function itself, not <ClassName>.render.
    const navBatch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const hocFnScreen = screens(navBatch).find((s) => s.name === 'HOCWrappedFn');
    expect(hocFnScreen).toBeDefined();
    expect(hocFnScreen!.componentFunctionId).not.toBeNull();
    const screenBatch = await extract('src/screens/HOCWrappedFunctionScreen.tsx', NAV_FIXTURE_ROOT);
    const fn = screenBatch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition'
        && (n as { name: string }).name === 'HOCWrappedFunctionScreen',
    );
    expect(fn).toBeDefined();
    expect(hocFnScreen!.componentFunctionId).toBe(fn!.id);
  });

  it('class-component screen FunctionDefinition.id matches lang-ts <ClassName>.render emission', async () => {
    // This is the "ids agree" check: extract the PlayerScreen file
    // and verify the FunctionDefinition emitted for `PlayerScreen.render`
    // has the same id the AppNavigator-side resolution computed.
    const navBatch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const playerBatch = await extract('src/screens/PlayerScreen.tsx', NAV_FIXTURE_ROOT);
    const playerScreen = screens(navBatch).find((s) => s.name === 'Player');
    const renderFn = playerBatch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition'
        && (n as { name: string }).name === 'PlayerScreen.render',
    );
    expect(renderFn).toBeDefined();
    expect(playerScreen!.componentFunctionId).toBe(renderFn!.id);
  });

  it('detects Tab.Screen with correct navigatorKind', async () => {
    const batch = await extract('src/AppNavigator.tsx', NAV_FIXTURE_ROOT);
    const tabScreen = screens(batch).find((s) => s.name === 'HomeTab');
    expect(tabScreen).toBeDefined();
    expect(tabScreen!.navigatorKind).toBe('tab');
  });

  it('detects navigation.navigate calls in screen components', async () => {
    const batch = await extract('src/screens/HomeScreen.tsx', NAV_FIXTURE_ROOT);
    const navEdges = batch.edges.filter((e) => e.edgeType === 'NAVIGATES_TO');
    expect(navEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('detects event handlers and lifecycle hooks in screen components', async () => {
    const batch = await extract('src/screens/HomeScreen.tsx', NAV_FIXTURE_ROOT);
    const procs = processes(batch);
    const effect = procs.find((p) => p.name === 'useEffect');
    expect(effect).toBeDefined();
    expect(effect!.kind).toBe('lifecycle_hook');
    const press = procs.find((p) => p.name === 'onPress');
    expect(press).toBeDefined();
    expect(press!.kind).toBe('event_handler');
  });
});

describe('React Navigation deep-link config (#127)', () => {
  it('populates routePath from `linking.config.screens.<name>: "<path>"`', async () => {
    const batch = await extract('src/DeepLinkApp.tsx', NAV_FIXTURE_ROOT);
    const profile = screens(batch).find((s) => s.name === 'Profile');
    expect(profile).toBeDefined();
    expect(profile!.routePath).toBe('profile/:id');
  });

  it("populates routePath from `Settings: { path: 'settings' }` (object form)", async () => {
    const batch = await extract('src/DeepLinkApp.tsx', NAV_FIXTURE_ROOT);
    const settings = screens(batch).find((s) => s.name === 'Settings');
    expect(settings).toBeDefined();
    expect(settings!.routePath).toBe('settings');
  });

  it('populates routePath from `Home: ""` (empty string)', async () => {
    const batch = await extract('src/DeepLinkApp.tsx', NAV_FIXTURE_ROOT);
    const home = screens(batch).find((s) => s.name === 'Home');
    expect(home).toBeDefined();
    expect(home!.routePath).toBe('');
  });

  it('leaves routePath null/undefined when no deep-link entry', async () => {
    const batch = await extract('src/DeepLinkApp.tsx', NAV_FIXTURE_ROOT);
    const about = screens(batch).find((s) => s.name === 'About');
    expect(about).toBeDefined();
    expect(about!.routePath).toBeFalsy();
  });

  it('every emitted Screen passes schema validation', async () => {
    const batch = await extract('src/DeepLinkApp.tsx', NAV_FIXTURE_ROOT);
    for (const s of screens(batch)) {
      expect(() => validateNode(s)).not.toThrow();
    }
  });

  it('navigate("Profile") edge target matches the declared Screen id even with deep-link routePath (#251 review B1)', async () => {
    // Regression test: routePath is payload-only; including it in
    // idFor.screen would orphan every NAVIGATES_TO edge emitted by
    // `navigation.navigate("X")` (which has no way to resolve the
    // linking config).
    const batch = await extract('src/DeepLinkApp.tsx', NAV_FIXTURE_ROOT);
    const profile = screens(batch).find((s) => s.name === 'Profile');
    expect(profile).toBeDefined();
    expect(profile!.routePath).toBe('profile/:id');
    const navEdge = batch.edges.find(
      (e) => e.edgeType === 'NAVIGATES_TO' && e.to === profile!.id,
    );
    expect(navEdge).toBeDefined();
  });
});

describe('end-to-end with canonical store', () => {
  it('all nodes commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const rn = new ReactNativePlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(rn.visitor);
      const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
      const batch = await ts.extractFile(handle, 'src/Screen.tsx');
      store.commit(batch, makeBatchMeta('ts'));

      const allProcesses = store.findNodes('ClientSideProcess');
      expect(allProcesses.length).toBeGreaterThan(0);
      for (const p of allProcesses) {
        expect(p.framework).toBe('react-native');
      }
    } finally {
      store.close();
    }
  });
});
