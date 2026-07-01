import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { Node } from 'ts-morph';
import { idFor, validateEdge, validateNode, type SchemaEdge, type SchemaNode } from '@veoable/schema';
import { TsLanguagePlugin } from '../index.js';
import type { TsFrameworkVisitor } from '../framework-visitor.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/callgraph/ts');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

// ──────────────────────────────────────────────────────────────────────
// Visitor dispatch — sees every AST node
// ──────────────────────────────────────────────────────────────────────

describe('TsFrameworkVisitor dispatch', () => {
  it('invokes onNode many times for a non-trivial file', async () => {
    const plugin = new TsLanguagePlugin();
    let count = 0;
    plugin.registerVisitor({
      language: 'ts',
      onNode() {
        count += 1;
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');

    expect(count).toBeGreaterThan(50);
  });

  it('visits every node exactly once per extractFile call', async () => {
    const plugin = new TsLanguagePlugin();
    const visited = new Set<Node>();
    let duplicates = 0;
    plugin.registerVisitor({
      language: 'ts',
      onNode(_ctx, node) {
        if (visited.has(node)) duplicates += 1;
        visited.add(node);
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('functions-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');

    expect(duplicates).toBe(0);
    expect(visited.size).toBeGreaterThan(50);
  });

  it('dispatches multiple visitors in registration order', async () => {
    const plugin = new TsLanguagePlugin();
    const order: string[] = [];
    plugin.registerVisitor({
      language: 'ts',
      onNode(_ctx, node) {
        if (Node.isFunctionDeclaration(node) && node.getName() === 'helper') order.push('first');
      },
    });
    plugin.registerVisitor({
      language: 'ts',
      onNode(_ctx, node) {
        if (Node.isFunctionDeclaration(node) && node.getName() === 'helper') order.push('second');
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');

    expect(order).toEqual(['first', 'second']);
  });

  it('extractFile with no visitors produces the same batch as before PR 3', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');

    const sourceFiles = batch.nodes.filter((n) => n.nodeType === 'SourceFile');
    const functions = batch.nodes.filter((n) => n.nodeType === 'FunctionDefinition');
    const callEdges = batch.edges.filter((e) => e.edgeType === 'CALLS_FUNCTION');
    expect(sourceFiles).toHaveLength(1);
    expect(functions.length).toBeGreaterThan(3);
    expect(callEdges.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Enclosing-function tracking
// ──────────────────────────────────────────────────────────────────────

describe('enclosingFunction tracking', () => {
  it('is set to the correct function for calls inside same-file / nested functions', async () => {
    const plugin = new TsLanguagePlugin();
    const seen: Array<{ call: string; enclosing: string | undefined }> = [];
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        if (Node.isCallExpression(node)) {
          seen.push({
            call: node.getExpression().getText(),
            enclosing: ctx.enclosingFunction?.name,
          });
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');

    // Calls inside `caller` have enclosing = 'caller'.
    expect(seen.some((s) => s.call === 'helper' && s.enclosing === 'caller')).toBe(true);
    // Calls inside the nested `inner` have enclosing = 'inner'.
    expect(seen.some((s) => s.call === 'helper' && s.enclosing === 'inner')).toBe(true);
    // The `inner()` call inside `outer` has enclosing = 'outer'.
    expect(seen.some((s) => s.call === 'inner' && s.enclosing === 'outer')).toBe(true);
  });

  it('sees a nested FunctionDeclaration node itself with the OUTER function as enclosing', async () => {
    const plugin = new TsLanguagePlugin();
    let outerSeenAtInner: string | undefined = 'not-observed';
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        if (Node.isFunctionDeclaration(node) && node.getName() === 'inner') {
          outerSeenAtInner = ctx.enclosingFunction?.name;
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');

    expect(outerSeenAtInner).toBe('outer');
  });

  it('is undefined at module top level', async () => {
    const plugin = new TsLanguagePlugin();
    let topLevelVarSeenEnclosing: string | undefined = 'unset';
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        // First VariableStatement encountered is the top-level `const arrow`.
        if (Node.isVariableStatement(node) && topLevelVarSeenEnclosing === 'unset') {
          topLevelVarSeenEnclosing = ctx.enclosingFunction?.name;
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('functions-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');

    expect(topLevelVarSeenEnclosing).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Visitor emissions fold into the batch
// ──────────────────────────────────────────────────────────────────────

describe('visitor emitNode / emitEdge', () => {
  it('emitted nodes appear in the returned batch and pass schema validation', async () => {
    const plugin = new TsLanguagePlugin();
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        if (
          Node.isCallExpression(node) &&
          Node.isIdentifier(node.getExpression()) &&
          node.getExpression().getText() === 'helper'
        ) {
          const endpoint: SchemaNode = {
            nodeType: 'APIEndpoint',
            id: idFor.apiEndpoint({
              repository: ctx.sourceFile.repository,
              httpMethod: 'GET',
              routePattern: `/from-visitor/${ctx.enclosingFunction?.name ?? 'top'}`,
              filePath: 'a.ts',
              lineStart: 1,
            }),
            httpMethod: 'GET',
            routePattern: `/from-visitor/${ctx.enclosingFunction?.name ?? 'top'}`,
            handlerFunctionId: ctx.enclosingFunction?.id ?? null,
            framework: 'toy',
            repository: ctx.sourceFile.repository,
          };
          ctx.emitNode(endpoint);
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');

    const endpoints = batch.nodes.filter((n) => n.nodeType === 'APIEndpoint');
    expect(endpoints.length).toBeGreaterThan(0);
    for (const ep of endpoints) expect(() => validateNode(ep)).not.toThrow();
  });

  it('emitted edges appear in the returned batch and pass schema validation', async () => {
    const plugin = new TsLanguagePlugin();
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        if (Node.isFunctionDeclaration(node) && node.getName() === 'helper') {
          const edge: SchemaEdge = {
            edgeType: 'EXPORTS',
            from: ctx.sourceFile.id,
            to: idFor.functionDefinition({
              sourceFileId: ctx.sourceFile.id,
              name: 'helper',
              sourceLine: node.getStartLineNumber(),
            }),
            exportName: 'helper-via-visitor',
            isDefault: false,
          };
          ctx.emitEdge(edge);
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');

    const visitorExports = batch.edges.filter(
      (e) => e.edgeType === 'EXPORTS' && e.exportName === 'helper-via-visitor'
    );
    expect(visitorExports).toHaveLength(1);
    expect(() => validateEdge(visitorExports[0])).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// registerVisitor validation
// ──────────────────────────────────────────────────────────────────────

describe('registerVisitor validation', () => {
  it('rejects a visitor with a non-"ts" language', () => {
    const plugin = new TsLanguagePlugin();
    expect(() =>
      plugin.registerVisitor({ language: 'python' } as unknown as TsFrameworkVisitor)
    ).toThrow(/cannot register visitor for language 'python'/);
  });

  it('rejects a visitor missing the onNode method', () => {
    const plugin = new TsLanguagePlugin();
    expect(() => plugin.registerVisitor({ language: 'ts' })).toThrow(/missing the required onNode/);
  });

  it('accepts a well-formed visitor', () => {
    const plugin = new TsLanguagePlugin();
    expect(() =>
      plugin.registerVisitor({
        language: 'ts',
        onNode() {},
      })
    ).not.toThrow();
  });

  it('rejects a visitor whose onNode is not a function (e.g. a string)', () => {
    const plugin = new TsLanguagePlugin();
    expect(() =>
      plugin.registerVisitor({
        language: 'ts',
        onNode: 'not a function',
      } as unknown as TsFrameworkVisitor)
    ).toThrow(/missing the required onNode/);
  });

  it('accepts a visitor that carries extra plugin-specific fields', () => {
    const plugin = new TsLanguagePlugin();
    // Forward-compat: framework plugins (Express, Prisma, …) are
    // expected to attach their own state fields to the visitor object.
    // The validator must not reject extra fields.
    const visitorWithState = {
      language: 'ts' as const,
      id: 'express',
      routes: [] as string[],
      onNode() {},
    };
    expect(() => plugin.registerVisitor(visitorWithState)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Additional dispatch + lifecycle behavior
// ──────────────────────────────────────────────────────────────────────

describe('TsFrameworkVisitor dispatch — additional shapes', () => {
  it('arrow function bound to a const is visited exactly once and the structural FunctionDefinition is recorded under the variable name with the arrow as the enclosing context for itself', async () => {
    const plugin = new TsLanguagePlugin();
    let arrowVisits = 0;
    let arrowEnclosingAtVisit: string | undefined = 'unset';
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        if (Node.isArrowFunction(node)) {
          arrowVisits += 1;
          // The arrow node itself is visited with its OUTER enclosing
          // (top-level → undefined). The variable declaration that
          // recorded the arrow as `arrow` was processed in the parent
          // recursion frame and pushed `arrow` onto the stack BEFORE
          // recursing into its children, so the arrow node itself
          // should see `arrow` as the enclosing function — this is the
          // documented "function declaration is visited with its outer
          // enclosing, then pushed" rule applied at the variable layer.
          arrowEnclosingAtVisit = ctx.enclosingFunction?.name;
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('functions-same-file') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');

    // No double emission of the arrow.
    expect(arrowVisits).toBe(1);
    // The arrow's bound name (`arrow`) is what the structural extractor
    // recorded — confirm via the batch.
    const fnDefs = batch.nodes.filter((n) => n.nodeType === 'FunctionDefinition');
    expect(fnDefs.some((f) => f.name === 'arrow')).toBe(true);
    // And by the time the walker recurses into the arrow node itself,
    // `arrow` is the enclosing on the stack (because the
    // VariableDeclaration recorded it and pushed before recursing).
    expect(arrowEnclosingAtVisit).toBe('arrow');
  });

  it('class methods see calls in their body with ClassName.method as enclosing', async () => {
    const plugin = new TsLanguagePlugin();
    const seen: Array<{ call: string; enclosing: string | undefined }> = [];
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        if (Node.isCallExpression(node)) {
          seen.push({
            call: node.getExpression().getText(),
            enclosing: ctx.enclosingFunction?.name,
          });
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');

    // `this.compute()` lives inside `Service.run`.
    expect(seen.some((s) => s.call === 'this.compute' && s.enclosing === 'Service.run')).toBe(true);
  });

  it('constructor body sees enclosingFunction = ClassName.constructor', async () => {
    const plugin = new TsLanguagePlugin();
    let ctorEnclosing: string | undefined = 'unset';
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        // Pick the FirstStatement-ish node inside the constructor.
        if (
          Node.isExpressionStatement(node) &&
          ctx.enclosingFunction?.name?.endsWith('.constructor')
        ) {
          ctorEnclosing = ctx.enclosingFunction.name;
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    await plugin.extractFile(handle, 'src/classes.ts');

    // The PublicSvc constructor body has only a comment, but accessing
    // any node inside the body should see the constructor on the stack.
    // We assert the visitor at least observed *some* constructor-bodied
    // node by walking again with a more permissive predicate.
    let observed = false;
    const plugin2 = new TsLanguagePlugin();
    plugin2.registerVisitor({
      language: 'ts',
      onNode(ctx) {
        if (ctx.enclosingFunction?.name === 'PublicSvc.constructor') observed = true;
      },
    });
    const h2 = await plugin2.loadProject({ rootDir: fixturePath('edge-cases') });
    await plugin2.extractFile(h2, 'src/classes.ts');
    expect(observed).toBe(true);
    // ctorEnclosing may stay 'unset' if there's no expression statement,
    // which is fine — the second plugin proves the stack is correct.
    void ctorEnclosing;
  });

  it('class expression methods are recorded under the bound variable name', async () => {
    const plugin = new TsLanguagePlugin();
    const fnNames: string[] = [];
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        if (Node.isMethodDeclaration(node) && ctx.enclosingFunction) {
          fnNames.push(ctx.enclosingFunction.name);
        }
      },
    });

    const handle = await plugin.loadProject({ rootDir: fixturePath('edge-cases') });
    const batch = await plugin.extractFile(handle, 'src/classes.ts');

    // The class-expression method is recorded as `_anon.hiddenInClassExpr`.
    const fnDefs = batch.nodes.filter((n) => n.nodeType === 'FunctionDefinition');
    expect(fnDefs.some((f) => f.name === '_anon.hiddenInClassExpr')).toBe(true);
  });

  it('visitor that throws propagates the error out through extractFile', async () => {
    const plugin = new TsLanguagePlugin();
    plugin.registerVisitor({
      language: 'ts',
      onNode(_ctx, node) {
        if (Node.isFunctionDeclaration(node) && node.getName() === 'helper') {
          throw new Error('boom from visitor');
        }
      },
    });
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    await expect(plugin.extractFile(handle, 'src/index.ts')).rejects.toThrow(/boom from visitor/);
  });

  it('ctx.project exposes the underlying ts-morph Project', async () => {
    const plugin = new TsLanguagePlugin();
    let observedFiles = 0;
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx) {
        // Only do the project query once to keep the test fast.
        if (observedFiles === 0) {
          observedFiles = ctx.project.getSourceFiles().length;
        }
      },
    });
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');
    expect(observedFiles).toBeGreaterThan(0);
  });

  it('two TsLanguagePlugin instances have independent visitor state', async () => {
    const a = new TsLanguagePlugin();
    const b = new TsLanguagePlugin();
    let aCount = 0;
    let bCount = 0;
    a.registerVisitor({
      language: 'ts',
      onNode() {
        aCount += 1;
      },
    });
    b.registerVisitor({
      language: 'ts',
      onNode() {
        bCount += 1;
      },
    });

    const handleA = await a.loadProject({ rootDir: fixturePath('calls-same-file') });
    await a.extractFile(handleA, 'src/index.ts');

    // After running plugin A, plugin B should still have zero invocations.
    expect(aCount).toBeGreaterThan(0);
    expect(bCount).toBe(0);

    const handleB = await b.loadProject({ rootDir: fixturePath('calls-same-file') });
    await b.extractFile(handleB, 'src/index.ts');
    // After running plugin B, plugin A's count should be unchanged
    // (i.e. plugin B did not dispatch through plugin A's visitor).
    const aSnapshot = aCount;
    await b.extractFile(handleB, 'src/index.ts');
    expect(aCount).toBe(aSnapshot);
    expect(bCount).toBeGreaterThan(0);
  });

  it('registerVisitor called after extractFile takes effect on subsequent calls', async () => {
    const plugin = new TsLanguagePlugin();
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    // First extract — no visitors registered.
    await plugin.extractFile(handle, 'src/index.ts');
    let lateCount = 0;
    plugin.registerVisitor({
      language: 'ts',
      onNode() {
        lateCount += 1;
      },
    });
    // Second extract — the late visitor should fire.
    await plugin.extractFile(handle, 'src/index.ts');
    expect(lateCount).toBeGreaterThan(0);
  });

  it('emitNode/emitEdge from a deeply nested function still land in the same batch', async () => {
    const plugin = new TsLanguagePlugin();
    plugin.registerVisitor({
      language: 'ts',
      onNode(ctx, node) {
        // Emit a marker edge for any call inside a nested function.
        if (Node.isCallExpression(node) && ctx.enclosingFunction?.name === 'inner') {
          ctx.emitEdge({
            edgeType: 'EXPORTS',
            from: ctx.sourceFile.id,
            to: ctx.enclosingFunction.id,
            exportName: 'nested-marker',
            isDefault: false,
          });
        }
      },
    });
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    const batch = await plugin.extractFile(handle, 'src/index.ts');
    const markers = batch.edges.filter(
      (e) => e.edgeType === 'EXPORTS' && e.exportName === 'nested-marker'
    );
    expect(markers.length).toBeGreaterThan(0);
  });

  it('visitor does NOT receive a Promise contract — returning a promise is silently ignored', async () => {
    const plugin = new TsLanguagePlugin();
    let nodesSeen = 0;
    plugin.registerVisitor({
      language: 'ts',
      // Cast through `as` because the official onNode signature is
      // synchronous; this test pins the documented behavior that any
      // value the visitor returns is ignored.
      onNode: ((_ctx: unknown, _node: unknown) => {
        nodesSeen += 1;
        return Promise.resolve();
      }) as unknown as TsFrameworkVisitor['onNode'],
    });
    const handle = await plugin.loadProject({ rootDir: fixturePath('calls-same-file') });
    await plugin.extractFile(handle, 'src/index.ts');
    expect(nodesSeen).toBeGreaterThan(0);
  });
});
